import axios, { AxiosInstance, AxiosError } from 'axios';
import * as cheerio from 'cheerio';
import { AnimeUnityResult, AnimeUnityEpisode, StreamData } from './types/animeunity';

const BASE_URL = 'https://www.animeunity.so';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const HEADERS = { 'User-Agent': USER_AGENT };
const TIMEOUT = 20;

export class AnimeUnityExtractor {
  private cookies: { [key: string]: string } = {};
  private csrfToken: string = '';
  private sessionHeaders: { [key: string]: string } = {};

  private async getSessionTokens(): Promise<void> {
    try {
      console.log('🔄 Getting session tokens...');
      
      const response = await axios.get(`${BASE_URL}/`, {
        headers: HEADERS,
        timeout: TIMEOUT * 1000
      });

      const $ = cheerio.load(response.data);
      this.csrfToken = $('meta[name=csrf-token]').attr('content') || '';

      // Estrai cookies come fa il Python
      const setCookieHeaders = response.headers['set-cookie'];
      if (setCookieHeaders) {
        this.cookies = {};
        setCookieHeaders.forEach(cookieHeader => {
          const [cookiePair] = cookieHeader.split(';');
          const [name, value] = cookiePair.split('=');
          if (name && value) {
            this.cookies[name.trim()] = value.trim();
          }
        });
      }

      // Crea session headers identici al Python
      this.sessionHeaders = {
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/json;charset=utf-8',
        'X-CSRF-Token': this.csrfToken,
        'Referer': BASE_URL,
        'User-Agent': USER_AGENT
      };

      console.log(`✅ Session tokens obtained`);
      console.log(`🔑 CSRF Token: ${this.csrfToken.substring(0, 10)}...`);
      
    } catch (error: unknown) {
      const axiosError = error as AxiosError;
      console.error('❌ Failed to get session tokens:', axiosError.message);
      throw error;
    }
  }

  async search(query: string): Promise<AnimeUnityResult[]> {
    // Ottieni token di sessione (come Python)
    await this.getSessionTokens();
    
    const results: AnimeUnityResult[] = [];
    const seenIds = new Set<number>();

    // Endpoint di ricerca (identici al Python)
    const searchEndpoints = [
      { url: `${BASE_URL}/livesearch`, payload: { title: query } },
      { 
        url: `${BASE_URL}/archivio/get-animes`, 
        payload: {
          title: query, type: false, year: false,
          order: 'Lista A-Z', status: false, genres: false,
          season: false, offset: 0, dubbed: false
        }
      }
    ];

    console.log(`🔍 Starting search for: "${query}"`);

    for (const endpoint of searchEndpoints) {
      try {
        console.log(`🔍 Searching via ${endpoint.url}`);
        
        // Crea headers per la richiesta (come Python)
        const requestHeaders = { ...this.sessionHeaders };
        if (this.cookies && Object.keys(this.cookies).length > 0) {
          requestHeaders['Cookie'] = Object.entries(this.cookies)
            .map(([key, value]) => `${key}=${value}`)
            .join('; ');
        }
        
        const response = await axios.post(endpoint.url, endpoint.payload, {
          headers: requestHeaders,
          timeout: TIMEOUT * 1000
        });

        if (response.status === 200 && response.data.records) {
          const recordsCount = response.data.records.length;
          console.log(`✅ Found ${recordsCount} results`);

          for (const record of response.data.records) {
            const animeId = record.id;
            if (!seenIds.has(animeId)) {
              seenIds.add(animeId);
              const title = record.title_it || record.title_eng || record.title || '';
              const languageType = this.detectLanguageType(title);
              
              results.push({
                id: animeId,
                slug: record.slug,
                name: title.trim(),
                episodes_count: record.episodes_count || 0,
                language_type: languageType
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
      // Ottieni conteggio episodi (come Python)
      const countResponse = await axios.get(`${BASE_URL}/info_api/${animeId}/`, {
        headers: HEADERS,
        timeout: TIMEOUT * 1000
      });
      
      const totalEpisodes = countResponse.data.episodes_count || 0;
      
      // Recupera episodi in batch (come Python)
      let start = 1;
      while (start <= totalEpisodes) {
        const end = Math.min(start + 119, totalEpisodes);
        
        const episodesResponse = await axios.get(`${BASE_URL}/info_api/${animeId}/1`, {
          params: { start_range: start, end_range: end },
          headers: HEADERS,
          timeout: TIMEOUT * 1000
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
    // Usa il metodo principale (come Python)
    return this.extractEmbedAndMp4Links(animeId, animeSlug, episodeId);
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
        timeout: TIMEOUT * 1000
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
        timeout: TIMEOUT * 1000,
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

  private detectLanguageType(title: string): 'Original' | 'Italian Dub' | 'Italian Sub' {
    const lower = title.toLowerCase();
    if (lower.includes('(ita)') || lower.endsWith(' ita')) {
      return 'Italian Dub';
    } else if (lower.includes('sub ita') || lower.includes('sub-ita')) {
      return 'Italian Sub';
    }
    return 'Original';
  }

  // Alias per compatibilità con il codice esistente
  async searchAllVersions(baseTitle: string): Promise<AnimeUnityResult[]> {
    return this.search(baseTitle);
  }
}
