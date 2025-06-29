import axios, { AxiosInstance, AxiosError } from 'axios';
import * as cheerio from 'cheerio';
import { AnimeUnityResult, AnimeUnityEpisode, StreamData } from '../types/animeunity';

const BASE_URL = 'https://www.animeunity.so';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'it-IT,it;q=0.8,en-US;q=0.5,en;q=0.3',
  'Accept-Encoding': 'gzip, deflate, br',
  'DNT': '1',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1'
};

export class AnimeUnityExtractor {
  private cookieJar: string = '';
  private csrfToken: string = '';
  private sessionValid: boolean = false;

  private async refreshSessionWithCookies(): Promise<void> {
    try {
      console.log('🔄 Refreshing AnimeUnity session with cookie management...');
      
      // Reset stato
      this.cookieJar = '';
      this.csrfToken = '';
      this.sessionValid = false;

      // Prima richiesta per ottenere cookie di sessione
      const homeResponse = await axios.get(`${BASE_URL}/`, {
        headers: {
          ...HEADERS,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        },
        timeout: 30000,
        withCredentials: false // Disabilita withCredentials per gestione manuale
      });

      // Estrai CSRF token
      const $ = cheerio.load(homeResponse.data);
      this.csrfToken = $('meta[name=csrf-token]').attr('content') || '';

      // Estrai e salva TUTTI i cookie manualmente
      const setCookieHeaders = homeResponse.headers['set-cookie'];
      if (setCookieHeaders && setCookieHeaders.length > 0) {
        this.cookieJar = setCookieHeaders
          .map(cookie => cookie.split(';')[0]) // Prendi solo name=value
          .join('; ');
        
        console.log(`✅ Session refreshed successfully`);
        console.log(`🔑 CSRF Token: ${this.csrfToken.substring(0, 10)}...`);
        console.log(`🍪 Cookies extracted: ${this.cookieJar.length} chars`);
        console.log(`🍪 Cookie sample: ${this.cookieJar.substring(0, 100)}...`);
        
        this.sessionValid = true;
      } else {
        throw new Error('No cookies received from homepage');
      }

      if (!this.csrfToken) {
        throw new Error('CSRF token not found in homepage');
      }

    } catch (error: unknown) {
      const axiosError = error as AxiosError;
      console.error('❌ Failed to refresh session:', axiosError.message);
      this.sessionValid = false;
      throw error;
    }
  }

  private async makeAuthenticatedRequest(endpoint: string, data: any): Promise<any> {
    // Assicurati che la sessione sia valida
    if (!this.sessionValid) {
      await this.refreshSessionWithCookies();
    }

    const requestHeaders = {
      ...HEADERS,
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json;charset=utf-8',
      'X-Requested-With': 'XMLHttpRequest',
      'X-CSRF-Token': this.csrfToken,
      'Referer': `${BASE_URL}/`,
      'Origin': BASE_URL,
      'Cookie': this.cookieJar // CRITICO: Include cookie manualmente
    };

    console.log(`📤 Making request to ${endpoint}`);
    console.log(`🔑 Using CSRF: ${this.csrfToken.substring(0, 10)}...`);
    console.log(`🍪 Using cookies: ${this.cookieJar.substring(0, 50)}...`);

    try {
      const response = await axios.post(`${BASE_URL}${endpoint}`, data, {
        headers: requestHeaders,
        timeout: 30000,
        withCredentials: false // Gestione manuale
      });

      console.log(`✅ Request successful: ${response.status}`);
      return response;

    } catch (error: unknown) {
      const axiosError = error as AxiosError;
      
      if (axiosError.response?.status === 419) {
        console.log('🔄 CSRF expired, refreshing session and retrying...');
        await this.refreshSessionWithCookies();
        
        // Retry con nuova sessione
        const retryHeaders = {
          ...HEADERS,
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json;charset=utf-8',
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRF-Token': this.csrfToken,
          'Referer': `${BASE_URL}/`,
          'Origin': BASE_URL,
          'Cookie': this.cookieJar
        };

        const retryResponse = await axios.post(`${BASE_URL}${endpoint}`, data, {
          headers: retryHeaders,
          timeout: 30000,
          withCredentials: false
        });

        console.log(`✅ Retry successful: ${retryResponse.status}`);
        return retryResponse;
      }
      
      throw error;
    }
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
    } else if (lower.includes('sub ita') || lower.includes('sub-ita')) {
      return 'Italian Sub';
    }
    return 'Original';
  }

  async searchAllVersions(baseTitle: string): Promise<AnimeUnityResult[]> {
    const results: AnimeUnityResult[] = [];
    const seenIds = new Set<number>();

    // ✅ RIPRISTINATA: Logica completa per tutte le varianti linguistiche
    const variants = ['', ' (ITA)', ' ITA', ' SUB ITA'];
    const endpoints = [
      { url: '/livesearch', isLive: true },
      { url: '/archivio/get-animes', isLive: false }
    ];

    console.log(`🔍 Starting search for: "${baseTitle}"`);

    for (const variant of variants) {
      const searchTerm = baseTitle + variant;
      
      for (const endpoint of endpoints) {
        try {
          console.log(`🔍 Searching: "${searchTerm}" via ${endpoint.url}`);
          
          const payload = endpoint.isLive 
            ? { title: searchTerm }
            : {
                title: searchTerm, type: false, year: false,
                order: 'Lista A-Z', status: false, genres: false,
                season: false, offset: 0, dubbed: false
              };

          const response = await this.makeAuthenticatedRequest(endpoint.url, payload);
          
          if (response.status === 200 && response.data.records) {
            const recordsCount = response.data.records.length;
            console.log(`✅ Found ${recordsCount} results for "${searchTerm}"`);

            for (const record of response.data.records) {
              const animeId = record.id;
              const title = record.title_it || record.title_eng || record.title || '';
              
              const normalizedFound = this.normalizeTitle(title);
              const normalizedSearch = this.normalizeTitle(baseTitle);
              
              // ✅ RIPRISTINATA: Logica di confronto per identificare stesso anime
              if (normalizedFound.toLowerCase() === normalizedSearch.toLowerCase() && !seenIds.has(animeId)) {
                seenIds.add(animeId);
                
                const languageType = this.detectLanguageType(title);
                results.push({
                  id: animeId,
                  slug: record.slug,
                  name: title.trim(),
                  episodes_count: record.episodes_count || 0,
                  language_type: languageType
                });
                
                console.log(`📺 Added: ${title} (${languageType}) - ID: ${animeId}`);
              }
            }
          }
        } catch (error: unknown) {
          const axiosError = error as AxiosError;
          console.error(`❌ Search failed for "${searchTerm}":`, axiosError.response?.status || axiosError.message);
        }
      }
    }

    console.log(`🎯 Total unique anime versions found: ${results.length}`);
    return results;
  }

  async getEpisodesList(animeId: number): Promise<AnimeUnityEpisode[]> {
    const episodes: AnimeUnityEpisode[] = [];
    
    try {
      if (!this.sessionValid) {
        await this.refreshSessionWithCookies();
      }

      const countResponse = await axios.get(`${BASE_URL}/info_api/${animeId}/`, {
        headers: {
          ...HEADERS,
          'Accept': 'application/json, text/plain, */*',
          'Cookie': this.cookieJar
        },
        timeout: 30000
      });
      
      const totalEpisodes = countResponse.data.episodes_count || 0;
      let start = 1;
      
      while (start <= totalEpisodes) {
        const end = Math.min(start + 119, totalEpisodes);
        
        const episodesResponse = await axios.get(`${BASE_URL}/info_api/${animeId}/1`, {
          params: { start_range: start, end_range: end },
          headers: {
            ...HEADERS,
            'Accept': 'application/json, text/plain, */*',
            'Cookie': this.cookieJar
          },
          timeout: 30000
        });
        
        episodes.push(...episodesResponse.data.episodes.map((ep: any) => ({
          id: ep.id,
          number: ep.number,
          name: ep.name || `Episodio ${ep.number}`
        })));
        
        start = end + 1;
      }
      
      console.log(`📺 Loaded ${episodes.length} episodes for anime ${animeId}`);
    } catch (error: unknown) {
      const axiosError = error as AxiosError;
      console.error(`❌ Error fetching episodes for anime ${animeId}:`, axiosError.message);
    }
    
    return episodes;
  }

  async extractStreamData(animeId: number, animeSlug: string, episodeId: number): Promise<StreamData> {
    try {
      if (!this.sessionValid) {
        await this.refreshSessionWithCookies();
      }
      
      const episodeUrl = `/anime/${animeId}-${animeSlug}/${episodeId}`;
      const pageResponse = await axios.get(`${BASE_URL}${episodeUrl}`, {
        headers: {
          ...HEADERS,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Cookie': this.cookieJar
        },
        timeout: 30000
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
      
    } catch (error: unknown) {
      const axiosError = error as AxiosError;
      console.error(`❌ Error extracting stream data:`, axiosError.message);
      return {};
    }
  }

  private async extractMp4FromVixCloud(embedUrl: string): Promise<string | null> {
    try {
      console.log(`🎥 Extracting MP4 from VixCloud: ${embedUrl}`);
      
      const response = await axios.get(embedUrl, {
        headers: {
          'Referer': BASE_URL,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeout: 30000,
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
      });
      
      const patterns = [
        /(?:src_mp4|file)\s*[:=]\s*["']([^"']+\.mp4[^"']*)["']/,
        /(?:file|source|src)\s*[:=]\s*["']([^"']*au-d1-[^"']*\.mp4[^"']*)["']/,
        /["']([^"']*scws-content\.net[^"']*\.mp4[^"']*)["']/,
        /(?:mp4|video)(?:Url|Source|File)\s*[:=]\s*["']([^"']+\.mp4[^"']*)["']/
      ];
      
      for (const pattern of patterns) {
        const matches = response.data.match(pattern);
        if (matches) {
          let cleanUrl = matches[1].replace(/\\\//g, '/');
          if (cleanUrl.startsWith('http') && cleanUrl.includes('token=') && cleanUrl.includes('expires=')) {
            console.log(`✅ MP4 URL extracted successfully`);
            return cleanUrl;
          }
        }
      }
      
      console.log(`❌ No valid MP4 URL found in VixCloud response`);
      return null;
      
    } catch (error: unknown) {
      const axiosError = error as AxiosError;
      console.error('❌ Error extracting MP4 from VixCloud:', axiosError.message);
      return null;
    }
  }
}
