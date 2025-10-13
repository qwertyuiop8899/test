import logging
import re
from typing import List, Dict, Any, Optional, Tuple
from urllib.parse import urljoin

logger = logging.getLogger(__name__)


def parse_hls_playlist(playlist_content: str, base_url: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Parses an HLS master playlist to extract stream information.

    Args:
        playlist_content (str): The content of the M3U8 master playlist.
        base_url (str, optional): The base URL of the playlist for resolving relative stream URLs. Defaults to None.

    Returns:
        List[Dict[str, Any]]: A list of dictionaries, each representing a stream variant.
    """
    streams = []
    lines = playlist_content.strip().split('\n')
    
    # Regex to capture attributes from #EXT-X-STREAM-INF
    stream_inf_pattern = re.compile(r'#EXT-X-STREAM-INF:(.*)')
    
    for i, line in enumerate(lines):
        if line.startswith('#EXT-X-STREAM-INF'):
            stream_info = {'raw_stream_inf': line}
            match = stream_inf_pattern.match(line)
            if not match:
                logger.warning(f"Could not parse #EXT-X-STREAM-INF line: {line}")
                continue
            attributes_str = match.group(1)
            
            # Parse attributes like BANDWIDTH, RESOLUTION, etc.
            attributes = re.findall(r'([A-Z-]+)=("([^"]+)"|([^,]+))', attributes_str)
            for key, _, quoted_val, unquoted_val in attributes:
                value = quoted_val if quoted_val else unquoted_val
                if key == 'RESOLUTION':
                    try:
                        width, height = map(int, value.split('x'))
                        stream_info['resolution'] = (width, height)
                    except ValueError:
                        stream_info['resolution'] = (0, 0)
                else:
                    stream_info[key.lower().replace('-', '_')] = value
            
            # The next line should be the stream URL
            if i + 1 < len(lines) and not lines[i + 1].startswith('#'):
                stream_url = lines[i + 1].strip()
                stream_info['url'] = urljoin(base_url, stream_url) if base_url else stream_url
                streams.append(stream_info)
                
    return streams