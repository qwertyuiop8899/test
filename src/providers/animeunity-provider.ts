import { AnimeUnityExtractor } from '../extractors/animeunity';
import { KitsuProvider } from './kitsu';
import { formatMediaFlowUrl } from '../utils/mediaflow';
import { AnimeUnityConfig, StreamForStremio } from '../types/animeunity'; // ✅ CORRETTO: Import aggiunto

export class AnimeUnityProvider {
  private extractor = new AnimeUnityExtractor();
  private kitsuProvider = new KitsuProvider();

  constructor(private config: AnimeUnityConfig) {}

  async handleKitsuRequest(kitsuIdString: string): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) {
      return { streams: [] };
    }

    try {
      const { kitsuId, episodeNumber, isMovie } = this.kitsuProvider.parseKitsuId(kitsuIdString);
      
      const animeInfo = await this.kitsuProvider.getAnimeInfo(kitsuId);
      if (!animeInfo) {
        return { streams: [] };
      }
      
      const normalizedTitle = this.kitsuProvider.normalizeTitle(animeInfo.title);
      const animeVersions = await this.extractor.searchAllVersions(normalizedTitle);
      
      if (!animeVersions.length) {
        return { streams: [] };
      }
      
      if (isMovie) {
        return {
          streams: animeVersions.map(version => ({
            title: `🎬 AnimeUnity ${version.language_type}`,
            url: `${this.config.mfpUrl}/anime/${version.id}-${version.slug}`,
            behaviorHints: {
              notWebReady: true
            }
          }))
        };
      }
      
      const streams: StreamForStremio[] = [];
      
      for (const version of animeVersions) {
        try {
          const episodes = await this.extractor.getEpisodesList(version.id);
          const targetEpisode = episodes.find(ep => ep.number === episodeNumber);
          
          if (!targetEpisode) continue;
          
          const streamResult = await this.extractor.extractStreamData(
            version.id,
            version.slug,
            targetEpisode.id
          );
          
          if (streamResult.mp4_url) {
            const mediaFlowUrl = formatMediaFlowUrl(
              streamResult.mp4_url,
              this.config.mfpUrl,
              this.config.mfpPassword
            );
            
            streams.push({
              title: `🎬 AnimeUnity ${version.language_type}`,
              url: mediaFlowUrl,
              behaviorHints: {
                notWebReady: true
              }
            });
            
            if (this.config.bothLink && streamResult.embed_url) {
              streams.push({
                title: `🎥 AnimeUnity ${version.language_type} (Embed)`,
                url: streamResult.embed_url,
                behaviorHints: {
                  notWebReady: true
                }
              });
            }
          }
        } catch (error) {
          console.error(`Error processing version ${version.language_type}:`, error);
        }
      }
      
      return { streams };
    } catch (error) {
      console.error('Error handling Kitsu request:', error);
      return { streams: [] };
    }
  }
}
