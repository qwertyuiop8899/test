import { addonBuilder, getRouter, Manifest, Stream } from "stremio-addon-sdk";
import { getStreamContent, VixCloudStreamInfo, ExtractorConfig } from "./extractor";
import * as fs from 'fs';
import { landingTemplate } from './landingPage';
import * as path from 'path';
import express from 'express';
import { AnimeUnityExtractor } from './extractors/animeunity';
import { KitsuProvider } from './providers/kitsu'; 
import { formatMediaFlowUrl } from './utils/mediaflow';

// Interfaccia per la configurazione URL
interface AddonConfig {
  mediaFlowProxyUrl?: string;
  mediaFlowProxyPassword?: string;
  tmdbApiKey?: string;
  bothLinks?: string;
  animeunityEnabled?: string; // ✅ NUOVO: Aggiunto parametro AnimeUnity
  [key: string]: any;
}

// ✅ NUOVO: Classe provider AnimeUnity
class AnimeUnityProvider {
  private extractor = new AnimeUnityExtractor();
  private kitsuProvider = new KitsuProvider();

  constructor(private config: any) {}

  async handleKitsuRequest(kitsuIdString: string): Promise<{ streams: Stream[] }> {
    if (!this.config.animeunityEnabled) {
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
      
      const streams: Stream[] = [];
      
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
              this.config.mfpPsw
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

// Base manifest configuration
const baseManifest: Manifest = {
    id: "org.stremio.vixcloud",
    version: "1.4.1",
    name: "StreamViX",
    description: "Addon for Vixsrc streams.", 
    icon: "/public/icon.png",
    background: "/public/backround.png",
    types: ["movie", "series"],
    idPrefixes: ["tt", "kitsu"], // ✅ MODIFICATO: Aggiunto "kitsu"
    catalogs: [],
    resources: ["stream"],
    behaviorHints: {
        configurable: true
    },
    config: [
        {
            key: "tmdbApiKey",
            title: "TMDB API Key",
            type: "password"
        },
        {
            key: "mediaFlowProxyUrl", 
            title: "MediaFlow Proxy URL (Rimuovere / finale!)",
            type: "text"
        },
        {
            key: "mediaFlowProxyPassword",
            title: "MediaFlow Proxy Password ", 
            type: "password"
        },
        {
            key: "bothLinks",
            title: "Mostra entrambi i link (Proxy e Direct)",
            type: "checkbox"
        },
        {
            key: "animeunityEnabled", // ✅ NUOVO: Parametro AnimeUnity
            title: "Enable AnimeUnity (Kitsu Catalog)",
            type: "checkbox"
        }
    ]
};

// Load custom configuration if available
function loadCustomConfig(): Manifest {
    try {
        const configPath = path.join(__dirname, '..', 'addon-config.json');
        
        if (fs.existsSync(configPath)) {
            const customConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            
            return {
                ...baseManifest,
                id: customConfig.addonId || baseManifest.id,
                name: customConfig.addonName || baseManifest.name,
                description: customConfig.addonDescription || baseManifest.description,
                version: customConfig.addonVersion || baseManifest.version,
                logo: customConfig.addonLogo || baseManifest.logo,
                icon: customConfig.addonLogo || baseManifest.icon,
                background: baseManifest.background
            };
        }
    } catch (error) {
        console.error('Error loading custom configuration:', error);
    }
    
    return baseManifest;
}

// Funzione per parsare la configurazione dall'URL
function parseConfigFromArgs(args: any): AddonConfig {
    const config: AddonConfig = {};
    
    // Se args è una stringa, prova a decodificarla come JSON
    if (typeof args === 'string') {
        try {
            // La configurazione nell'URL di Stremio è codificata in base64
            const decoded = decodeURIComponent(args);
            const parsed = JSON.parse(decoded);
            return parsed;
        } catch (error) {
            // Ignora l'errore se non è un JSON valido o non è codificato
            return {};
        }
    }
    
    // Se args è già un oggetto, usalo direttamente
    if (typeof args === 'object' && args !== null) {
        return args;
    }
    
    return config;
}

// Funzione per creare il builder con configurazione dinamica
function createBuilder(config: AddonConfig = {}) {
    // Use the configured manifest
    const manifest = loadCustomConfig();
    
    // Modifica il manifest in base alla configurazione
    if (config.mediaFlowProxyUrl || config.bothLinks || config.tmdbApiKey) {
        manifest.name;
    }
    
    const builder = new addonBuilder(manifest);

    builder.defineStreamHandler(
        async ({
            id,
            type,
        }): Promise<{
            streams: Stream[];
        }> => {
            try {
                console.log(`🔍 Stream request: ${type}/${id}`);
                
                const allStreams: Stream[] = [];
                
                // ✅ NUOVO: Gestione AnimeUnity per ID Kitsu
                if (config.animeunityEnabled === 'on' && id.startsWith('kitsu:')) {
                    console.log(`🎌 Processing Kitsu ID: ${id}`);
                    try {
                        const bothLinkValue = config.bothLinks === 'on';
                        
                        const animeUnityConfig = {
                            animeunityEnabled: true,
                            mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL,
                            mfpPsw: config.mediaFlowProxyPassword || process.env.MFP_PSW,
                            bothLink: bothLinkValue
                        };
                        
                        const animeUnityProvider = new AnimeUnityProvider(animeUnityConfig);
                        const animeUnityResult = await animeUnityProvider.handleKitsuRequest(id);
                        console.log(`🎌 AnimeUnity streams found: ${animeUnityResult.streams.length}`);
                        allStreams.push(...animeUnityResult.streams);
                    } catch (error) {
                        console.error('🚨 AnimeUnity error:', error);
                    }
                }
                
                // ✅ ESISTENTE: Mantieni logica VixSrc per tutti gli altri ID (NON MODIFICATA)
                if (!id.startsWith('kitsu:')) {
                    console.log(`📺 Processing non-Kitsu ID with VixSrc: ${id}`);
                    
                    // Priorità: Configurazione utente (URL) > Variabili d'ambiente (.env/secrets)
                    let bothLinkValue: boolean;
                    // Se la config dall'URL contiene 'bothLinks', essa ha la precedenza assoluta.
                    // Un checkbox non spuntato non viene incluso nel FormData, quindi `config.bothLinks` sarà undefined.
                    if (config.bothLinks !== undefined) {
                        bothLinkValue = config.bothLinks === 'on';
                    } else {
                        // Altrimenti, usa la variabile d'ambiente come fallback.
                        bothLinkValue = process.env.BOTHLINK?.toLowerCase() === 'true';
                    }

                    const finalConfig: ExtractorConfig = {
                        tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY,
                        mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL,
                        mfpPsw: config.mediaFlowProxyPassword || process.env.MFP_PSW,
                        bothLink: bothLinkValue
                    };

                    const res: VixCloudStreamInfo[] | null = await getStreamContent(id, type, finalConfig);

                    if (res) {
                        for (const st of res) {
                            if (st.streamUrl == null) continue;
                            
                            console.log(`Adding stream with title: "${st.name}"`);

                            const streamName = st.source === 'proxy' ? 'StreamViX (Proxy)' : 'StreamViX';
                            
                            allStreams.push({
                                title: st.name,
                                name: streamName,
                                url: st.streamUrl,
                                behaviorHints: {
                                    notWebReady: true,
                                    headers: { "Referer": st.referer },
                                },
                            });
                        }
                        console.log(`📺 VixSrc streams found: ${res.length}`);
                    }
                }
                
                console.log(`✅ Total streams returned: ${allStreams.length}`);
                return { streams: allStreams };
            } catch (error) {
                console.error('Stream extraction failed:', error);
                return { streams: [] };
            }
        }
    );

    return builder;
}

// --- Inizio del nuovo server Express ---

const app = express();

// Serve i file statici (icona, sfondo) dalla directory public
// Assumendo che la cartella 'public' sia nella root del progetto, accanto a 'src'
app.use('/public', express.static(path.join(__dirname, '..', 'public')));

// Route per la landing page
app.get('/', (_, res) => {
    const manifest = loadCustomConfig(); // Usa il manifest per generare la pagina
    const landingHTML = landingTemplate(manifest);
    res.setHeader('Content-Type', 'text/html');
    res.send(landingHTML);
});

// Middleware che crea dinamicamente l'interfaccia dell'addon per ogni richiesta
// Questo preserva la tua logica di configurazione dinamica
app.use((req, res, next) => {
    const configString = req.path.split('/')[1];
    const config = parseConfigFromArgs(configString);
    const builder = createBuilder(config);
    
    const addonInterface = builder.getInterface();
    const router = getRouter(addonInterface);
    
    router(req, res, next);
});

const PORT = process.env.PORT || 7860;
app.listen(PORT, () => {
    console.log(`Addon server running on http://127.0.0.1:${PORT}`);
});
