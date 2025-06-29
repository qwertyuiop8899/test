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



  async search(query: string): Promise<AnimeUnityResult[]> {
    const results: AnimeUnityResult[] = [];
    const seenIds = new Set<number>();

    // Endpoint di ricerca (come Python script)
    const endpoints = [
      { url: '/livesearch', payload: { title: query } },
      { 
        url: '/archivio/get-animes', 
        payload: {
          title: query, type: false, year: false,
          order: 'Lista A-Z', status: false, genres: false,
          season: false, offset: 0, dubbed: false
        }
      }
    ];

    console.log(`🔍 Starting search for: "${query}"`);

    for (const endpoint of endpoints) {
      try {
        console.log(`🔍 Searching via ${endpoint.url}`);
        
        const response = await this.makeAuthenticatedRequest(endpoint.url, endpoint.payload);
        
        if (response.status === 200 && response.data.records) {
          const recordsCount = response.data.records.length;
          console.log(`✅ Found ${recordsCount} results`);

          for (const record of response.data.records) {
            const animeId = record.id;
            if (!seenIds.has(animeId)) {
              seenIds.add(animeId);
              const title = record.title_it || record.title_eng || record.title || '';
              
              results.push({
                id: animeId,
                slug: record.slug,
                name: title.trim(),
                episodes_count: record.episodes_count || 0
              });
              
              console.log(`📺 Added: ${title} - ID: ${animeId}`);
            }
          }
        }
      } catch (error: unknown) {
        const axiosError = error as AxiosError;
        console.error(`❌ Search failed for ${endpoint.url}:`, axiosError.response?.status || axiosError.message);
      }
    }

    console.log(`🎯 Total unique anime found: ${results.length}`);
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

  async extractEmbedAndMp4Links(animeId: number, animeSlug: string, episodeId: number): Promise<StreamData> {
    // Ottieni contenuto pagina episodio (come Python)
    const pageContent = await this.getVideoPageContent(animeId, animeSlug, episodeId);
    if (!pageContent) {
      return { embed_url: undefined, mp4_url: undefined, episode_page: undefined };
    }

    const episodePageUrl = `${BASE_URL}/anime/${animeId}-${animeSlug}/${episodeId}`;

    // Cerca embed URL di VixCloud (come Python)
    const $ = cheerio.load(pageContent);
    let embedUrl: string | undefined = undefined;

    // Cerca video-player tag con embed_url
    const videoPlayer = $('video-player');
    if (videoPlayer.length > 0 && videoPlayer.attr('embed_url')) {
      embedUrl = videoPlayer.attr('embed_url');

      // Normalizza URL se necessario
      if (embedUrl?.startsWith('//')) {
        embedUrl = 'https:' + embedUrl;
      } else if (embedUrl?.startsWith('/')) {
        embedUrl = BASE_URL + embedUrl;
      }
    }

    // Fallback: cerca iframe VixCloud (come Python)
    if (!embedUrl) {
      const iframeMatch = pageContent.match(/<iframe[^>]+src="([^"]*vixcloud[^"]+)"/);
      if (iframeMatch) {
        embedUrl = iframeMatch[1];
        if (embedUrl.startsWith('//')) {
          embedUrl = 'https:' + embedUrl;
        } else if (embedUrl.startsWith('/')) {
          embedUrl = BASE_URL + embedUrl;
        }
      }
    }

    // Estrai MP4 dall'embed URL (se trovato) - come Python
    let mp4Url: string | undefined = undefined;
    if (embedUrl) {
      mp4Url = await this.extractMp4FromVixCloud(embedUrl) || undefined;
    }

    return {
      episode_page: episodePageUrl,
      embed_url: embedUrl,
      mp4_url: mp4Url
    };
  }

  private async getVideoPageContent(animeId: number, animeSlug: string, episodeId: number): Promise<string | null> {
    // Ottiene contenuto pagina episodio per estrazione embed URL (come Python)
    const episodeUrl = `${BASE_URL}/anime/${animeId}-${animeSlug}/${episodeId}`;

    try {
      const response = await axios.get(episodeUrl, {
        headers: HEADERS,
        timeout: 30000
      });
      return response.data;
    } catch (error: unknown) {
      const axiosError = error as AxiosError;
      console.error(`⚠️ Errore caricamento pagina episodio: ${axiosError.message}`);
      return null;
    }
  }

  private async extractMp4FromVixCloud(embedUrl: string): Promise<string | null> {
    try {
      console.log(`🎥 Extracting MP4 from VixCloud: ${embedUrl}`);
      
      // Headers specifici per VixCloud (come nello script Python)
      const parsedUrl = new URL(embedUrl);
      const vixcloudHeaders = {
        'Host': parsedUrl.hostname,
        'Referer': BASE_URL,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      };

      const response = await axios.get(embedUrl, {
        headers: vixcloudHeaders,
        timeout: 30000,
        // Disabilita verifica certificati SSL come nello script Python
        validateStatus: () => true
      });

      const $ = cheerio.load(response.data);

      // Metodo 1: Cerca script con src_mp4 (logica MP4_downloader - come Python)
      const scripts = $('script');
      for (let i = 0; i < scripts.length; i++) {
        const scriptContent = $(scripts[i]).html();
        if (scriptContent) {
          // Pattern per link MP4 diretto
          const mp4Match = scriptContent.match(/(?:src_mp4|file)\s*[:=]\s*["']([^"']+\.mp4[^"']*)["']/);
          if (mp4Match) {
            let mp4Url = mp4Match[1];
            // Decodifica eventuali escape sequences
            mp4Url = mp4Url.replace(/\\\//g, '/');
            if (mp4Url.startsWith('http')) {
              console.log(`✅ MP4 URL found in script (Method 1): ${mp4Url.substring(0, 50)}...`);
              return mp4Url;
            }
          }
        }
      }

      // Metodo 2: Cerca variabili JavaScript con URL MP4 (come Python)
      const fullText = response.data;
      const mp4Patterns = [
        /(?:file|source|src)\s*[:=]\s*["']([^"']*au-d1-[^"']*\.mp4[^"']*)["']/g,
        /["']([^"']*scws-content\.net[^"']*\.mp4[^"']*)["']/g,
        /(?:mp4|video)(?:Url|Source|File)\s*[:=]\s*["']([^"']+\.mp4[^"']*)["']/g
      ];

      for (const pattern of mp4Patterns) {
        let match;
        pattern.lastIndex = 0; // Reset regex
        while ((match = pattern.exec(fullText)) !== null) {
          let cleanUrl = match[1].replace(/\\\//g, '/');
          if (cleanUrl.includes('token=') && cleanUrl.includes('expires=')) {
            console.log(`✅ MP4 URL found with tokens (Method 2): ${cleanUrl.substring(0, 50)}...`);
            return cleanUrl;
          }
        }
      }

      // Metodo 3: Parsing JSON configuration (fallback per M3U8->MP4 - come Python)
      const jsonMatch = fullText.match(/(?:config|window\.config)\s*=\s*(\{.*?\});/s);
      if (jsonMatch) {
        try {
          const config = JSON.parse(jsonMatch[1]);
          console.log('🔍 Found JSON config, parsing...');

          // Cerca URL base e converti da M3U8 a MP4
          const configKeys = ['masterPlaylist', 'window_parameter', 'streams'];
          for (const key of configKeys) {
            if (config[key] && typeof config[key] === 'object') {
              const baseUrl = config[key].url || '';
              if (baseUrl.includes('playlist') && baseUrl.includes('vixcloud.co')) {
                console.log(`🔍 Found playlist URL in ${key}: ${baseUrl.substring(0, 50)}...`);
                
                // Sostituisci /playlist/ con /download/ per ottenere MP4
                let mp4Url = baseUrl.replace('/playlist/', '/download/');
                mp4Url = mp4Url.replace('m3u8', 'mp4');

                // Aggiungi parametri di qualità se disponibili
                const params = config[key].params || {};
                if (params) {
                  const token = params.token || '';
                  const expires = params.expires || '';
                  if (token && expires) {
                    const separator = mp4Url.includes('?') ? '&' : '?';
                    mp4Url += `${separator}token=${token}&expires=${expires}`;

                    // Aggiungi qualità se FHD disponibile
                    if (config.canPlayFHD) {
                      mp4Url += '&quality=1080p';
                    }

                    console.log(`✅ MP4 URL constructed from config (Method 3): ${mp4Url.substring(0, 50)}...`);
                    return mp4Url;
                  }
                }
              }
            }
          }
        } catch (jsonError) {
          console.log('⚠️ JSON config parsing failed:', jsonError);
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
