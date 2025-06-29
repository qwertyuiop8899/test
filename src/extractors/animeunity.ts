import axios, { AxiosInstance, AxiosError } from 'axios';
import * as cheerio from 'cheerio';
import { AnimeUnityResult, AnimeUnityEpisode, StreamData } from '../types/animeunity';

const BASE_URL = 'https://www.animeunity.so';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

export class AnimeUnityExtractor {
  private axiosInstance: AxiosInstance;
  private csrfToken: string = '';
  private cookieJar: string = '';
  private sessionInitialized: boolean = false;

  constructor() {
    // Crea istanza axios con configurazione robusta per gestione cookie
    this.axiosInstance = axios.create({
      baseURL: BASE_URL,
      timeout: 30000,
      headers: HEADERS,
      withCredentials: true,
      maxRedirects: 5,
      validateStatus: (status) => status < 500 // Accetta anche 4xx per gestire errori CSRF
    });

    // Intercettore per gestione automatica dei cookie
    this.axiosInstance.interceptors.response.use(
      (response) => {
        // Salva automaticamente i cookie dalle risposte Set-Cookie
        if (response.headers['set-cookie']) {
          this.cookieJar = response.headers['set-cookie']
            .map(cookie => cookie.split(';')[0])
            .join('; ');
        }
        return response;
      },
      (error: AxiosError) => {
        // Reset sessione se si riceve 419 (CSRF expired)
        if (error.response?.status === 419) {
          console.log('🔄 CSRF token expired, resetting session...');
          this.sessionInitialized = false;
          this.csrfToken = '';
          this.cookieJar = '';
        }
        return Promise.reject(error);
      }
    );
  }

  private async initializeSession(): Promise<void> {
    if (this.sessionInitialized && this.csrfToken && this.cookieJar) {
      return;
    }

    console.log('🔄 Initializing AnimeUnity session...');

    try {
      // Prima richiesta per ottenere cookie di sessione e token CSRF
      const homeResponse = await this.axiosInstance.get('/', {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'it-IT,it;q=0.8,en-US;q=0.5,en;q=0.3',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Upgrade-Insecure-Requests': '1'
        }
      });

      const $ = cheerio.load(homeResponse.data);
      this.csrfToken = $('meta[name=csrf-token]').attr('content') || '';

      if (!this.csrfToken) {
        throw new Error('CSRF token not found in homepage');
      }

      // I cookie vengono salvati automaticamente dall'intercettore
      this.sessionInitialized = true;
      console.log(`✅ Session initialized - CSRF: ${this.csrfToken.substring(0, 10)}...`);
      console.log(`🍪 Cookies: ${this.cookieJar.substring(0, 50)}...`);

    } catch (error: unknown) {
      // ✅ Fix TypeScript TS18046: Type casting esplicito
      const axiosError = error as AxiosError;
      console.error('❌ Failed to initialize session:', axiosError.message);
      throw error;
    }
  }

  private async makeAuthenticatedRequest(endpoint: string, data: any): Promise<any> {
    await this.initializeSession();

    const requestConfig = {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=utf-8',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': this.csrfToken,
        'Referer': BASE_URL + '/',
        'Origin': BASE_URL,
        'Accept-Language': 'it-IT,it;q=0.8,en-US;q=0.5,en;q=0.3',
        'Cache-Control': 'no-cache',
        'Cookie': this.cookieJar, // Include cookie di sessione
        ...HEADERS
      },
      withCredentials: true
    };

    return await this.axiosInstance.post(endpoint, data, requestConfig);
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

    // Varianti linguistiche da cercare (replica logica paste-2)
    const variants = ['', ' (ITA)', ' ITA', ' SUB ITA', ' Sub ITA'];
    const endpoints = [
      { url: '/livesearch', isLive: true },
      { url: '/archivio/get-animes', isLive: false }
    ];

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
            console.log(`✅ Search successful: ${recordsCount} results for "${searchTerm}"`);

            for (const record of response.data.records) {
              const animeId = record.id;
              const title = record.title_it || record.title_eng || record.title || '';
              
              const normalizedFound = this.normalizeTitle(title);
              const normalizedSearch = this.normalizeTitle(baseTitle);
              
              // Confronto titoli normalizzati per identificare stesso anime
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
                
                console.log(`📺 Found: ${title} (${languageType})`);
              }
            }
          }
        } catch (error: unknown) {
          // ✅ Fix TypeScript TS18046: Gestione sicura dell'errore
          const axiosError = error as AxiosError;
          console.error(`❌ Search failed for "${searchTerm}":`, axiosError.response?.status || axiosError.message);
          
          // Se otteniamo 419, forza reinizializzazione sessione
          if (axiosError.response?.status === 419) {
            this.sessionInitialized = false;
            this.csrfToken = '';
            this.cookieJar = '';
            
            // Retry una sola volta con nuova sessione
            try {
              await this.initializeSession();
              const retryResponse = await this.makeAuthenticatedRequest(endpoint.url, payload);
              if (retryResponse.status === 200 && retryResponse.data.records) {
                console.log(`🔄 Retry successful after session refresh`);
                // Processa i risultati del retry...
              }
            } catch (retryError: unknown) {
              const retryAxiosError = retryError as AxiosError;
              console.error(`❌ Retry also failed:`, retryAxiosError.message);
            }
          }
        }
      }
    }

    console.log(`🎯 Total unique anime versions found: ${results.length}`);
    return results;
  }

  async getEpisodesList(animeId: number): Promise<AnimeUnityEpisode[]> {
    const episodes: AnimeUnityEpisode[] = [];
    
    try {
      await this.initializeSession();
      
      const countResponse = await this.axiosInstance.get(`/info_api/${animeId}/`, {
        headers: {
          'Cookie': this.cookieJar,
          ...HEADERS
        }
      });
      
      const totalEpisodes = countResponse.data.episodes_count || 0;
      let start = 1;
      
      // Carica episodi in batch di 120 (logica paste-2)
      while (start <= totalEpisodes) {
        const end = Math.min(start + 119, totalEpisodes);
        
        const episodesResponse = await this.axiosInstance.get(`/info_api/${animeId}/1`, {
          params: { start_range: start, end_range: end },
          headers: {
            'Cookie': this.cookieJar,
            ...HEADERS
          }
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
      // ✅ Fix TypeScript TS18046
      const axiosError = error as AxiosError;
      console.error(`❌ Error fetching episodes for anime ${animeId}:`, axiosError.message);
    }
    
    return episodes;
  }

  async extractStreamData(animeId: number, animeSlug: string, episodeId: number): Promise<StreamData> {
    try {
      await this.initializeSession();
      
      const episodeUrl = `/anime/${animeId}-${animeSlug}/${episodeId}`;
      const pageResponse = await this.axiosInstance.get(episodeUrl, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Cookie': this.cookieJar,
          ...HEADERS
        }
      });
      
      const $ = cheerio.load(pageResponse.data);
      
      // Estrazione embed URL VixCloud (logica paste-2)
      let embedUrl = $('video-player').attr('embed_url');
      
      if (!embedUrl) {
        // Fallback: cerca iframe VixCloud
        const iframeMatch = pageResponse.data.match(/<iframe[^>]+src="([^"]*vixcloud[^"]+)"/);
        if (iframeMatch) {
          embedUrl = iframeMatch[1];
        }
      }
      
      if (!embedUrl) {
        return { episode_page: BASE_URL + episodeUrl };
      }
      
      // Normalizza URL embed
      if (embedUrl.startsWith('//')) {
        embedUrl = 'https:' + embedUrl;
      } else if (embedUrl.startsWith('/')) {
        embedUrl = BASE_URL + embedUrl;
      }
      
      // Estrai MP4 diretto da VixCloud
      const mp4Url = await this.extractMp4FromVixCloud(embedUrl);
      
      return {
        episode_page: BASE_URL + episodeUrl,
        embed_url: embedUrl,
        mp4_url: mp4Url || undefined
      };
      
    } catch (error: unknown) {
      // ✅ Fix TypeScript TS18046
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
          ...HEADERS
        },
        timeout: 30000,
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
      });
      
      // Pattern di estrazione MP4 (testati e funzionanti in paste-2)
      const patterns = [
        /(?:src_mp4|file)\s*[:=]\s*["']([^"']+\.mp4[^"']*)["']/,
        /(?:file|source|src)\s*[:=]\s*["']([^"']*au-d1-[^"']*\.mp4[^"']*)["']/,
        /["']([^"']*scws-content\.net[^"']*\.mp4[^"']*)["']/,
        /(?:mp4|video)(?:Url|Source|File)\s*[:=]\s*["']([^"']+\.mp4[^"']*)["']/
      ];
      
      for (const pattern of patterns) {
        const matches = response.data.match(pattern);
        if (matches) {
          let cleanUrl = matches[1].replace(/\\\//g, '/'); // Pulisci escape chars
          if (cleanUrl.startsWith('http') && cleanUrl.includes('token=') && cleanUrl.includes('expires=')) {
            console.log(`✅ MP4 URL extracted successfully`);
            return cleanUrl;
          }
        }
      }
      
      console.log(`❌ No valid MP4 URL found in VixCloud response`);
      return null;
      
    } catch (error: unknown) {
      // ✅ Fix TypeScript TS18046
      const axiosError = error as AxiosError;
      console.error('❌ Error extracting MP4 from VixCloud:', axiosError.message);
      return null;
    }
  }
}
