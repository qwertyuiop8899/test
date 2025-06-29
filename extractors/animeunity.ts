import axios from 'axios';
import * as cheerio from 'cheerio';
import { AnimeUnityResult, StreamData } from '../types/animeunity';

const BASE_URL = 'https://www.animeunity.so';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

export class AnimeUnityExtractor {
  private async getSessionTokens() {
    const response = await axios.get(`${BASE_URL}/`, { headers: HEADERS });
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
            timeout: 20000
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

  // Continua con altri metodi del paste-2.txt...
}
