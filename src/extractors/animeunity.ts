import axios, { AxiosInstance, AxiosError } from 'axios';
import * as cheerio from 'cheerio';
import { AnimeUnityResult, AnimeUnityEpisode, StreamData } from '../types/animeunity';

const BASE_URL = 'https://www.animeunity.so';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const TIMEOUT = 20000;

export class AnimeUnityExtractor {
  private axiosSession: AxiosInstance;
  private csrfToken: string = '';
  private sessionInitialized: boolean = false;

  constructor() {
    // Replica esatta di requests.Session() con withCredentials automatico
    this.axiosSession = axios.create({
      baseURL: BASE_URL,
      timeout: TIMEOUT,
      withCredentials: true,
      headers: {
        'User-Agent': USER_AGENT // User-Agent identico allo script Python
      }
    });

    // Gestione automatica errori 403 per reset sessione
    this.axiosSession.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        if (error.response?.status === 403) {
          console.log('🔄 403 Forbidden detected, resetting session...');
          this.sessionInitialized = false;
          this.csrfToken = '';
        }
        return Promise.reject(error);
      }
    );
  }

  private async getSessionTokens(): Promise<void> {
    try {
      console.log('🔄 Getting session tokens from homepage...');
      
      // Replica esatta della richiesta homepage Python
      const response = await this.axiosSession.get('/', {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'it-IT,it;q=0.8,en-US;q=0.5,en;q=0.3',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      });

      const $ = cheerio.load(response.data);
      this.csrfToken = $('meta[name=csrf-token]').attr('content') || '';

      if (!this.csrfToken) {
        throw new Error('CSRF token not found in homepage');
      }

      this.sessionInitialized = true;
      console.log(`✅ Session tokens obtained - CSRF: ${this.csrfToken.substring(0, 10)}...`);

    } catch (error: unknown) {
      const axiosError = error as AxiosError;
      console.error('❌ Failed to get session tokens:', axiosError.message);
      throw error;
    }
  }

  private async makeAuthenticatedRequest(endpoint: string, payload: any): Promise<any> {
    if (!this.sessionInitialized) {
      await this.getSessionTokens();
    }

    try {
      // Headers identici a quelli dello script Python per richieste JSON
      const response = await this.axiosSession.post(endpoint, payload, {
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/json;charset=utf-8',
          'X-CSRF-Token': this.csrfToken,
          'Referer': BASE_URL,
          'User-Agent': USER_AGENT,
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'it-IT,it;q=0.8,en-US;q=0.5,en;q=0.3'
        }
      });

      return response;

    } catch (error: unknown) {
      const axiosError = error as AxiosError;
      
      if (axiosError.response?.status === 403) {
        console.log('🔄 403 error, refreshing session and retrying...');
        
        // Reset completo e retry
        this.sessionInitialized = false;
        await this.getSessionTokens();
        
        const retryResponse = await this.axiosSession.post(endpoint, payload, {
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Type': 'application/json;charset=utf-8',
            'X-CSRF-Token': this.csrfToken,
            'Referer': BASE_URL,
            'User-Agent': USER_AGENT,
            'Accept': 'application/json, text/plain, */*'
          }
        });
        
        console.log('✅ Retry successful after session refresh');
        return retryResponse;
      }
      
      throw error;
    }
  }

  async searchAllVersions(baseTitle: string): Promise<AnimeUnityResult[]> {
    const results: AnimeUnityResult[] = [];
    const seenIds = new Set<number>();

    // Replica esatta delle varianti e endpoint dello script Python
    const searchVariants = ['', ' (ITA)', ' ITA', ' SUB ITA'];
    const searchEndpoints = [
      { url: '/livesearch', payload: (title: string) => ({ title }) },
      { 
        url: '/archivio/get-animes', 
        payload: (title: string) => ({
          title, type: false, year: false,
          order: 'Lista A-Z', status: false, genres: false,
          season: false, offset: 0, dubbed: false
        })
      }
    ];

    console.log(`🔍 Starting search for: "${baseTitle}"`);

    for (const variant of searchVariants) {
      const searchTerm = baseTitle + variant;
      
      for (const endpoint of searchEndpoints) {
        try {
          console.log(`🔍 Searching: "${searchTerm}" via ${endpoint.url}`);
          
          const response = await this.makeAuthenticatedRequest(
            endpoint.url,
            endpoint.payload(searchTerm)
          );

          if (response.status === 200 && response.data.records) {
            console.log(`✅ Found ${response.data.records.length} results for "${searchTerm}"`);

            for (const record of response.data.records) {
              const animeId = record.id;
              const title = record.title_it || record.title_eng || record.title || '';
              
              const normalizedFound = this.normalizeTitle(title);
              const normalizedSearch = this.normalizeTitle(baseTitle);
              
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
                
                console.log(`📺 Added: ${title} (${languageType})`);
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

  async getEpisodesList(animeId: number): Promise<AnimeUnityEpisode[]> {
    const episodes: AnimeUnityEpisode[] = [];
    
    try {
      if (!this.sessionInitialized) {
        await this.getSessionTokens();
      }

      // Replica esatta richieste API info_api
      const countResponse = await this.axiosSession.get(`/info_api/${animeId}/`, {
        headers: { 'User-Agent': USER_AGENT }
      });
      
      const totalEpisodes = countResponse.data.episodes_count || 0;
      let start = 1;
      
      while (start <= totalEpisodes) {
        const end = Math.min(start + 119, totalEpisodes);
        
        const episodesResponse = await this.axiosSession.get(`/info_api/${animeId}/1`, {
          params: { start_range: start, end_range: end },
          headers: { 'User-Agent': USER_AGENT }
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
      console.error(`❌ Error fetching episodes:`, axiosError.message);
    }
    
    return episodes;
  }

  async extractStreamData(animeId: number, animeSlug: string, episodeId: number): Promise<StreamData> {
    try {
      if (!this.sessionInitialized) {
        await this.getSessionTokens();
      }
      
      const episodeUrl = `/anime/${animeId}-${animeSlug}/${episodeId}`;
      const pageResponse = await this.axiosSession.get(episodeUrl, {
        headers: { 'User-Agent': USER_AGENT }
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
      
      // Replica esatta headers VixCloud + verify=False dello script Python
      const response = await axios.get(embedUrl, {
        headers: {
          'Referer': BASE_URL,
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        timeout: TIMEOUT,
        httpsAgent: new (require('https').Agent)({ 
          rejectUnauthorized: false  // Replica verify=False
        })
      });
      
      // Pattern matching identici allo script Python
      const patterns = [
        /(?:src_mp4|file)\s*[:=]\s*["']([^"']+\.mp4[^"']*)["']/,
        /(?:file|source|src)\s*[:=]\s*["']([^"']*au-d1-[^"']*\.mp4[^"']*)["']/,
        /["']([^"']*scws-content\.net[^"']*\.mp4[^"']*)["']/,
        /(?:mp4|video)(?:Url|Source|File)\s*[:=]\s*["']([^"']+\.mp4[^"']*)["']/
      ];
      
      for (const pattern of patterns) {
        const matches = response.data.match(pattern);
        if (matches) {
          let cleanUrl = matches[1].replace(/\\/g, '/'); // Replica replace("\\/", "/")
          if (cleanUrl.startsWith('http') && cleanUrl.includes('token=') && cleanUrl.includes('expires=')) {
            console.log(`✅ MP4 URL extracted successfully`);
            return cleanUrl;
          }
        }
      }
      
      console.log(`❌ No valid MP4 URL found`);
      return null;
      
    } catch (error: unknown) {
      const axiosError = error as AxiosError;
      console.error('❌ Error extracting MP4:', axiosError.message);
      return null;
    }
  }
}
