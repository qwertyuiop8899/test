import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import { AnimeUnityResult, AnimeUnityEpisode, StreamData } from '../types/animeunity';

const BASE_URL = 'https://www.animeunity.so';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

export class AnimeUnityExtractor {
  private axiosInstance: AxiosInstance;
  private csrfToken: string = '';
  private sessionCookies: string = '';
  private lastTokenTime: number = 0;

  constructor() {
    // Crea istanza axios con jar cookie automatico
    this.axiosInstance = axios.create({
      baseURL: BASE_URL,
      timeout: 20000,
      headers: HEADERS,
      withCredentials: true
    });
  }

  private async refreshSession(): Promise<void> {
    const now = Date.now();
    
    // Rinnova sessione ogni 2 minuti
    if (!this.csrfToken || (now - this.lastTokenTime) > 120000) {
      console.log('🔄 Refreshing AnimeUnity session...');
      
      try {
        const response = await this.axiosInstance.get('/');
        const $ = cheerio.load(response.data);
        
        this.csrfToken = $('meta[name=csrf-token]').attr('content') || '';
        
        // Estrai e salva tutti i cookie
        const setCookieHeaders = response.headers['set-cookie'];
        if (setCookieHeaders) {
          this.sessionCookies = setCookieHeaders
            .map(cookie => cookie.split(';')[0])
            .join('; ');
        }
        
        this.lastTokenTime = now;
        
        console.log(`✅ Session refreshed - Token: ${this.csrfToken.substring(0, 10)}...`);
        console.log(`🍪 Cookies: ${this.sessionCookies.substring(0, 50)}...`);
        
      } catch (error) {
        console.error('❌ Failed to refresh session:', error);
        throw error;
      }
    }
  }

  private async makeAuthenticatedRequest(endpoint: string, data: any): Promise<any> {
    await this.refreshSession();
    
    const config = {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/json;charset=utf-8',
        'X-CSRF-Token': this.csrfToken,
        'Referer': BASE_URL,
        'Cookie': this.sessionCookies,
        ...HEADERS
      }
    };
    
    return await this.axiosInstance.post(endpoint, data, config);
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
    const results: AnimeUnityResult[] = [];
    const seenIds = new Set<number>();

    const variants = ['', ' (ITA)', ' ITA', ' SUB ITA'];
    const endpoints = [
      { url: '/livesearch', isLive: true },
      { url: '/archivio/get-animes', isLive: false }
    ];

    for (const variant of variants) {
      const searchTerm = baseTitle + variant;
      
      for (const endpoint of endpoints) {
        try {
          console.log(`🔍 Searching: ${searchTerm} via ${endpoint.url}`);
          
          const payload = endpoint.isLive 
            ? { title: searchTerm }
            : {
                title: searchTerm, type: false, year: false,
                order: 'Lista A-Z', status: false, genres: false,
                season: false, offset: 0, dubbed: false
              };

          const response = await this.makeAuthenticatedRequest(endpoint.url, payload);
          
          console.log(`✅ Search successful: ${response.data.records?.length || 0} results`);

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
          console.error(`❌ Search failed for ${searchTerm}:`, error.response?.status || error.message);
        }
      }
    }

    console.log(`🎯 Total unique results found: ${results.length}`);
    return results;
  }

  async getEpisodesList(animeId: number): Promise<AnimeUnityEpisode[]> {
    const episodes: AnimeUnityEpisode[] = [];
    
    try {
      await this.refreshSession();
      
      const countResponse = await this.axiosInstance.get(`/info_api/${animeId}/`, {
        headers: {
          'Cookie': this.sessionCookies,
          ...HEADERS
        }
      });
      
      const totalEpisodes = countResponse.data.episodes_count || 0;
      let start = 1;
      
      while (start <= totalEpisodes) {
        const end = Math.min(start + 119, totalEpisodes);
        
        const episodesResponse = await this.axiosInstance.get(`/info_api/${animeId}/1`, {
          params: { start_range: start, end_range: end },
          headers: {
            'Cookie': this.sessionCookies,
            ...HEADERS
          }
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
      await this.refreshSession();
      
      const episodeUrl = `/anime/${animeId}-${animeSlug}/${episodeId}`;
      const pageResponse = await this.axiosInstance.get(episodeUrl, {
        headers: {
          'Cookie': this.sessionCookies,
          ...HEADERS
        }
      });
      
      const $ = cheerio.load(pageResponse.data);
      
      let embedUrl = $('video-player').attr('embed_url');
      
      if (!embedUrl) {
        const iframeMatch = pageResponse.data.match(/<iframe[^>]+src="([^"]*vixcloud[^"]+)"/);
        if (iframeMatch) {
          embedUrl = iframeMatch[1];
        }
      }
      
      if (!embedUrl) {
        return { episode_page: BASE_URL + episodeUrl };
      }
      
      if (embedUrl.startsWith('//')) {
        embedUrl = 'https:' + embedUrl;
      } else if (embedUrl.startsWith('/')) {
        embedUrl = BASE_URL + embedUrl;
      }
      
      const mp4Url = await this.extractMp4FromVixCloud(embedUrl);
      
      return {
        episode_page: BASE_URL + episodeUrl,
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
        timeout: 20000,
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
