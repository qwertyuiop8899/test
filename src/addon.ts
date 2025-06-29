import { addonBuilder, getConfigUrl, serveHTTP } from 'stremio-addon-sdk';
import extractor from './extractor'; // Mantieni il VixSrc extractor esistente
import { AnimeUnityExtractor } from './extractors/animeunity';
import { KitsuProvider } from './providers/kitsu';
import { formatMediaFlowUrl } from './utils/mediaflow';

// Configurazione addon con parametri per pagina installazione
const addonConfig = {
  id: 'org.streamv.multi',
  version: '1.0.0',
  name: 'StreamV + AnimeUnity',
  description: 'StreamV addon with VixSrc and AnimeUnity integration (Kitsu catalog)',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'kitsu'], // AGGIUNTO: supporto per ID Kitsu
  catalogs: [],
  config: [
    {
      key: "tmdb_api_key",
      type: "text",
      title: "TMDB API Key",
      required: true
    },
    {
      key: "mfp_url", 
      type: "text",
      title: "MediaFlow Proxy URL",
      required: true
    },
    {
      key: "mfp_psw",
      type: "password", 
      title: "MediaFlow Proxy Password",
      required: true
    },
    {
      key: "bothlink",
      type: "boolean",
      title: "Show Both Links (MFP + Direct)",
      default: false
    },
    {
      key: "animeunity_enabled", // NUOVO: parametro per abilitare AnimeUnity
      type: "boolean",
      title: "Enable AnimeUnity (Kitsu Catalog)",
      default: true
    }
  ]
};

// Inizializza provider AnimeUnity
class AnimeUnityProvider {
  private extractor = new AnimeUnityExtractor();
  private kitsuProvider = new KitsuProvider();

  constructor(private config: any) {}

  async handleKitsuRequest(kitsuIdString: string): Promise<{ streams: any[] }> {
    if (!this.config.animeunity_enabled) {
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
            url: `${this.config.mfp_url}/anime/${version.id}-${version.slug}`,
            behaviorHints: {
              bingeGroup: `animeunity_${version.language_type.toLowerCase().replace(' ', '_')}`
            }
          }))
        };
      }
      
      const streams: any[] = [];
      
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
              this.config.mfp_url,
              this.config.mfp_psw
            );
            
            streams.push({
              title: `🎬 AnimeUnity ${version.language_type}`,
              url: mediaFlowUrl,
              behaviorHints: {
                bingeGroup: `animeunity_${version.language_type.toLowerCase().replace(' ', '_')}`
              }
            });
            
            if (this.config.bothlink && streamResult.embed_url) {
              streams.push({
                title: `🎥 AnimeUnity ${version.language_type} (Embed)`,
                url: streamResult.embed_url,
                behaviorHints: {
                  bingeGroup: `animeunity_${version.language_type.toLowerCase().replace(' ', '_')}_embed`
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

const builder = new addonBuilder(addonConfig);

// Configurazione addon
builder.defineConfigHandler((config) => {
  console.log('🔧 Addon configurato con:', {
    animeUnityEnabled: config.animeunity_enabled,
    bothLink: config.bothlink
  });
  
  return Promise.resolve(addonConfig);
});

// Stream handler unificato
builder.defineStreamHandler(async (args, config) => {
  console.log(`🔍 Stream request: ${args.type}/${args.id}`);
  console.log(`🔧 Config ricevuta:`, {
    animeUnityEnabled: config.animeunity_enabled,
    bothLink: config.bothlink
  });
  
  const allStreams: any[] = [];
  
  // NUOVO: Gestione AnimeUnity per ID Kitsu
  if (config.animeunity_enabled && args.id.startsWith('kitsu:')) {
    console.log(`🎌 Processing Kitsu ID: ${args.id}`);
    try {
      const animeUnityProvider = new AnimeUnityProvider(config);
      const animeUnityResult = await animeUnityProvider.handleKitsuRequest(args.id);
      console.log(`🎌 AnimeUnity streams found: ${animeUnityResult.streams.length}`);
      allStreams.push(...animeUnityResult.streams);
    } catch (error) {
      console.error('🚨 AnimeUnity error:', error);
    }
  }
  
  // ESISTENTE: Mantieni logica VixSrc per tutti gli altri ID
  if (!args.id.startsWith('kitsu:')) {
    console.log(`📺 Processing non-Kitsu ID with VixSrc: ${args.id}`);
    try {
      const vixSrcResult = await extractor(args, config); // Passa config a VixSrc
      if (vixSrcResult?.streams) {
        console.log(`📺 VixSrc streams found: ${vixSrcResult.streams.length}`);
        allStreams.push(...vixSrcResult.streams);
      }
    } catch (error) {
      console.error('🚨 VixSrc error:', error);
    }
  }
  
  console.log(`✅ Total streams returned: ${allStreams.length}`);
  return { streams: allStreams };
});

// Setup server
const PORT = process.env.PORT || 7860;

serveHTTP(builder.getInterface(), { 
  port: PORT,
  configPath: '/config',
  configDir: '/'
});

console.log(`🚀 StreamV + AnimeUnity addon listening on port ${PORT}`);
console.log(`📋 Install URL: http://localhost:${PORT}/config`);
