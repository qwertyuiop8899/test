import axios from 'axios';
import * as cheerio from 'cheerio';
import { AnimeUnityResult, AnimeUnityEpisode, StreamData } from '../types/animeunity';

const BASE_URL = 'https://www.animeunity.so';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};
const TIMEOUT = 20000;

export class AnimeUnityExtractor {
  private async getSessionTokens() {
    const response = await axios.get(`${BASE_URL}/`, { 
      headers: HEADERS,
      timeout: TIMEOUT 
    });
    
    // ✅ CORRETTO: response.data invece di response.text
    const $ = cheerio.load(response.data);
    const csrfToken = $('meta[name=csrf-token]').attr('content') || '';
    
    return {
      sessionHeaders: {
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/json;charset=utf-8',
        'X-CSRF-Token': csrfToken,
        'Referer': BASE_URL,
        ...HEADERS
      }
    };
  }

  private normalizeTitle(title: string): string {
    return title
      .replace(/\s*\(ITA\)\s*/gi, '')
      .replace(/\s*ITA\s*$/gi, '')
      .replace(/\s*SUB\s*ITA\s*/gi, '')
      .trim();
  }

  private detectLanguageType(title: string): 'Original' | 'Italian Dub' | 'Italian Sub' {
    const lower = title.toLowerCase();
    if (lower.includes('(ita)') || lower.endsWith(' ita')) {
      return 'Italian Dub';
    } else if (lower.includes('sub ita')) {
      return 'Italian Sub';
    }
    return 'Original';
  }

  async searchAllVersions(baseTitle: string): Promise<AnimeUnityResult[]> {
    const session = await this.getSessionTokens();
    const results: AnimeUnityResult[] = [];
    const seenIds = new Set<number>();

    const variants = ['', ' (ITA)', ' ITA', ' SUB ITA'];
    const endpoints = [
      { url: `${BASE_URL}/livesearch`, isLive: true },
      { url: `${BASE_URL}/archivio/get-animes`, isLive: false }
    ];

    for (const variant of variants) {
      const searchTerm = baseTitle + variant;
      
      for (const endpoint of endpoints) {
        try {
          const payload = endpoint.isLive 
            ? { title: searchTerm }
            : {
                title: searchTerm, type: false, year: false,
                order: 'Lista A-Z', status: false, genres: false,
                season: false, offset: 0, dubbed: false
              };

          const response = await axios.post(endpoint.url, payload, {
            headers: session.sessionHeaders,
            timeout: TIMEOUT
          });

          for (const record of response.data.records || []) {
            const animeId = record.id;
            const title = record.title_it || record.title_eng || record.title || '';
            
            const normalizedFound = this.normalizeTitle(title);
            const normalizedSearch = this.normalizeTitle(baseTitle);
            
            if (normalizedFound.toLowerCase() === normalizedSearch.toLowerCase() && !seenIds.has(animeId)) {
              seenIds.add(animeId);
              
              results.push({
                id: animeId,
                slug: record.slug,
                name: title.trim(),
                episodes_count: record.episodes_count || 0,
                language_type: this.detectLanguageType(title)
              });
            }
          }
        } catch (error) {
          console.warn(`Search error for ${searchTerm}:`, error);
        }
      }
    }

    return results;
  }

  async getEpisodesList(animeId: number): Promise<AnimeUnityEpisode[]> {
    const episodes: AnimeUnityEpisode[] = [];
    
    try {
      const countResponse = await axios.get(`${BASE_URL}/info_api/${animeId}/`, {
        headers: HEADERS,
        timeout: TIMEOUT
      });
      
      const totalEpisodes = countResponse.data.episodes_count || 0;
      let start = 1;
      
      while (start <= totalEpisodes) {
        const end = Math.min(start + 119, totalEpisodes);
        
        const episodesResponse = await axios.get(`${BASE_URL}/info_api/${animeId}/1`, {
          params: { start_range: start, end_range: end },
          headers: HEADERS,
          timeout: TIMEOUT
        });
        
        episodes.push(...episodesResponse.data.episodes.map((ep: any) => ({
          id: ep.id,
          number: ep.number,
          name: ep.name || ''
        })));
        
        start = end + 1;
      }
    } catch (error) {
      console.error(`Error fetching episodes for anime ${animeId}:`, error);
    }
    
    return episodes;
  }

  async extractStreamData(animeId: number, animeSlug: string, episodeId: number): Promise<StreamData> {
    try {
      const episodeUrl = `${BASE_URL}/anime/${animeId}-${animeSlug}/${episodeId}`;
      const pageResponse = await axios.get(episodeUrl, { 
        headers: HEADERS,
        timeout: TIMEOUT 
      });
      
      // ✅ CORRETTO: response.data invece di response.text
      const $ = cheerio.load(pageResponse.data);
      
      let embedUrl = $('video-player').attr('embed_url');
      
      if (!embedUrl) {
        const iframeMatch = pageResponse.data.match(/<iframe[^>]+src="([^"]*vixcloud[^"]+)"/);
        if (iframeMatch) {
          embedUrl = iframeMatch[1];
        }
      }
      
      if (!embedUrl) {
        return { episode_page: episodeUrl };
      }
      
      if (embedUrl.startsWith('//')) {
        embedUrl = 'https:' + embedUrl;
      } else if (embedUrl.startsWith('/')) {
        embedUrl = BASE_URL + embedUrl;
      }
      
      const mp4Url = await this.extractMp4FromVixCloud(embedUrl);
      
      return {
        episode_page: episodeUrl,
        embed_url: embedUrl,
        mp4_url: mp4Url || undefined
      };
    } catch (error) {
      console.error(`Error extracting stream:`, error);
      return {};
    }
  }

  private async extractMp4FromVixCloud(embedUrl: string): Promise<string | null> {
    try {
      const response = await axios.get(embedUrl, {
        headers: {
          ...HEADERS,
          'Referer': BASE_URL
        },
        timeout: TIMEOUT,
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
      });
      
      const patterns = [
        /(?:src_mp4|file)\s*[:=]\s*["']([^"']+\.mp4[^"']*)["']/,
        /(?:file|source|src)\s*[:=]\s*["']([^"']*au-d1-[^"']*\.mp4[^"']*)["']/,
        /["']([^"']*scws-content\.net[^"']*\.mp4[^"']*)["']/
      ];
      
      for (const pattern of patterns) {
        const matches = response.data.match(pattern);
        if (matches) {
          let cleanUrl = matches[1].replace(/\\/g, '/');
          if (cleanUrl.startsWith('http') && cleanUrl.includes('token=') && cleanUrl.includes('expires=')) {
            return cleanUrl;
          }
        }
      }
      
      return null;
    } catch (error) {
      console.error('Error extracting MP4 from VixCloud:', error);
      return null;
    }
  }
}
