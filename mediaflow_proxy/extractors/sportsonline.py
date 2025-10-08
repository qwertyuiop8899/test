import re
import logging
from typing import Any, Dict, Optional
from urllib.parse import urlparse

from mediaflow_proxy.extractors.base import BaseExtractor, ExtractorError
from mediaflow_proxy.utils.packed import detect, unpack

logger = logging.getLogger(__name__)


class SportsonlineExtractor(BaseExtractor):
    """Sportsonline/Sportzonline URL extractor for M3U8 streams.

    Strategy:
    1. Fetch page -> find first <iframe src="...">
    2. Fetch iframe with Referer=https://sportsonline.si/
    3. Collect packed eval blocks; if >=2 use second (index 1) else first.
    4. Unpack P.A.C.K.E.R. and search var src="...m3u8".
    5. Return final m3u8 with referer header.

    Notes:
    - Multi-domain support for sportzonline.(st|bz|cc|top) and sportsonline.(si|sn)
    - Uses P.A.C.K.E.R. unpacking from utils.packed module
    - Returns streams suitable for hls_manifest_proxy endpoint
    """

    def __init__(self, request_headers: dict):
        super().__init__(request_headers)
        self.mediaflow_endpoint = "hls_manifest_proxy"

    def _detect_packed_blocks(self, html: str) -> list[str]:
        """
        Detect and extract packed eval blocks from HTML.
        Replicates Python regex: 'eval(function(.+?.+)'
        """
        pattern = re.compile(r"eval\(function(.+?\))\s*\)", re.DOTALL)
        raw_matches = []
        
        for match in pattern.finditer(html):
            # Reconstruct the full eval statement
            packed_code = f"eval(function{match.group(1)})"
            raw_matches.append(packed_code)
        
        return raw_matches

    async def extract(self, url: str, **kwargs) -> Dict[str, Any]:
        """Main extraction flow: fetch page, extract iframe, unpack and find m3u8."""
        try:
            # Step 1: Fetch main page
            logger.info(f"Fetching main page: {url}")
            main_response = await self._make_request(url, timeout=15)
            main_html = main_response.text

            # Extract first iframe
            iframe_match = re.search(r'<iframe\s+src=["\']([^"\']+)["\']', main_html, re.IGNORECASE)
            if not iframe_match:
                raise ExtractorError("No iframe found on the page")

            iframe_url = iframe_match.group(1)
            
            # Normalize iframe URL
            if iframe_url.startswith('//'):
                iframe_url = 'https:' + iframe_url
            elif iframe_url.startswith('/'):
                parsed_main = urlparse(url)
                iframe_url = f"{parsed_main.scheme}://{parsed_main.netloc}{iframe_url}"
            
            logger.info(f"Found iframe URL: {iframe_url}")

            # Step 2: Fetch iframe with Referer
            iframe_headers = {
                'Referer': 'https://sportsonline.si/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
                'Cache-Control': 'no-cache'
            }
            
            iframe_response = await self._make_request(iframe_url, headers=iframe_headers, timeout=15)
            iframe_html = iframe_response.text

            logger.debug(f"Iframe HTML length: {len(iframe_html)}")

            # Step 3: Detect packed blocks
            packed_blocks = self._detect_packed_blocks(iframe_html)
            
            if not packed_blocks:
                logger.warning("No packed blocks found, trying direct m3u8 search")
                # Fallback: try direct m3u8 search
                direct_match = re.search(r'(https?://[^\s"\'>]+\.m3u8[^\s"\'>]*)', iframe_html)
                if direct_match:
                    m3u8_url = direct_match.group(1)
                    logger.info(f"Found direct m3u8 URL: {m3u8_url}")
                    
                    return {
                        "destination_url": m3u8_url,
                        "request_headers": {
                            'Referer': iframe_url,
                            'User-Agent': iframe_headers['User-Agent']
                        },
                        "mediaflow_endpoint": self.mediaflow_endpoint,
                    }
                else:
                    raise ExtractorError("No packed blocks or direct m3u8 URL found")

            logger.info(f"Found {len(packed_blocks)} packed blocks")

            # Choose block: if >=2 use second (index 1), else first (index 0)
            chosen_idx = 1 if len(packed_blocks) > 1 else 0
            m3u8_url = None
            unpacked_code = None

            # Try to unpack chosen block
            try:
                unpacked_code = unpack(packed_blocks[chosen_idx])
                logger.debug(f"Unpacked block {chosen_idx} successfully")
            except Exception as e:
                logger.warning(f"Failed to unpack block {chosen_idx}: {e}")

            # Search for var src="...m3u8"
            if unpacked_code:
                src_match = re.search(r'var\s+src\s*=\s*["\']([^"\']+\.m3u8[^"\']*)["\']', unpacked_code)
                if not src_match:
                    # Try alternative patterns
                    src_match = re.search(r'src\s*=\s*["\']([^"\']+\.m3u8[^"\']*)["\']', unpacked_code)
                
                if src_match:
                    m3u8_url = src_match.group(1)

            # If not found, try all other blocks
            if not m3u8_url:
                logger.info("m3u8 not found in chosen block, trying all blocks")
                for i, block in enumerate(packed_blocks):
                    if i == chosen_idx:
                        continue
                    try:
                        unpacked_code = unpack(block)
                        src_match = re.search(r'var\s+src\s*=\s*["\']([^"\']+\.m3u8[^"\']*)["\']', unpacked_code)
                        if not src_match:
                            src_match = re.search(r'src\s*=\s*["\']([^"\']+\.m3u8[^"\']*)["\']', unpacked_code)
                        
                        if src_match:
                            m3u8_url = src_match.group(1)
                            logger.info(f"Found m3u8 in block {i}")
                            break
                    except Exception as e:
                        logger.debug(f"Failed to process block {i}: {e}")
                        continue

            if not m3u8_url:
                raise ExtractorError("Could not extract m3u8 URL from packed code")

            logger.info(f"Successfully extracted m3u8 URL: {m3u8_url}")

            # Return stream configuration
            return {
                "destination_url": m3u8_url,
                "request_headers": {
                    'Referer': iframe_url,
                    'User-Agent': iframe_headers['User-Agent']
                },
                "mediaflow_endpoint": self.mediaflow_endpoint,
            }

        except ExtractorError:
            raise
        except Exception as e:
            logger.exception(f"Sportsonline extraction failed for {url}")
            raise ExtractorError(f"Extraction failed: {str(e)}")
