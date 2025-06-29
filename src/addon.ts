import { addonBuilder, getRouter, Manifest, Stream } from "stremio-addon-sdk";
import { getStreamContent, VixCloudStreamInfo, ExtractorConfig } from "./extractor";
import * as fs from 'fs';
import { landingTemplate } from './landingPage';
import * as path from 'path';
import express from 'express';

// Interfaccia per la configurazione URL
interface AddonConfig {
  mediaFlowProxyUrl?: string;
  mediaFlowProxyPassword?: string;
  tmdbApiKey?: string;
  bothLinks?: string;
  [key: string]: any;
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
    idPrefixes: ["tt"],
    catalogs: [],
    resources: ["stream"], // Rimosso "landingTemplate" che non è più una risorsa valida
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
            type: "text"        },
        {
            key: "mediaFlowProxyPassword",
            title: "MediaFlow Proxy Password ", 
            type: "password"        },
        {
            key: "bothLinks",
            title: "Mostra entrambi i link (Proxy e Direct)",
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
        }): Promise<{ // Il gestore ha accesso a `config` dallo scope padre
            streams: Stream[];
        }> => {
            try {
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

                if (!res) {
                    return { streams: [] };
                }

                const streams: Stream[] = [];
                for (const st of res) {
                    if (st.streamUrl == null) continue;
                    
                    console.log(`Adding stream with title: "${st.name}"`);

                    const streamName = st.source === 'proxy' ? 'StreamViX (Proxy)' : 'StreamViX';
                    
                    streams.push({
                        title: st.name,
                        name: streamName,
                        url: st.streamUrl,
                        behaviorHints: {
                            notWebReady: true,
                            headers: { "Referer": st.referer },
                        },
                    });
                }
                return { streams };
            } catch (error) {
                console.error('Stream extraction failed:', error);
                return { streams: [] };
            }
        }
    );

    // La riga seguente è stata rimossa perché 'defineLandingTemplate' è obsoleto.
    // La landing page verrà servita da Express.
    // (builder as any).defineLandingTemplate(...)

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
    const router = getRouter(addonInterface); // ✅ Approccio corretto
    
    router(req, res, next);
});

const PORT = process.env.PORT || 7860;
app.listen(PORT, () => {
    console.log(`Addon server running on http://127.0.0.1:${PORT}`);
});
