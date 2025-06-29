import { addonBuilder, serveHTTP } from 'stremio-addon-sdk';
import extractor from './extractor'; // Import esistente VixSrc NON MODIFICARE
import { AnimeUnityProvider } from './providers/animeunity-provider';
import { config, validateConfig } from './utils/config';

// Valida configurazione
if (!validateConfig()) {
  process.exit(1);
}

// Inizializza provider AnimeUnity
const animeUnityProvider = new AnimeUnityProvider({
  mfpUrl: config.mfpUrl,
  mfpPassword: config.mfpPassword,
  bothLink: config.bothLink,
  enabled: config.animeUnityEnabled
});

const manifest = {
  id: 'org.streamv.multi',
  version: '1.0.0',
  name: config.animeUnityEnabled ? 'StreamV + AnimeUnity' : 'StreamV',
  description: config.animeUnityEnabled 
    ? 'StreamV addon with AnimeUnity integration (Kitsu catalog)'
    : 'StreamV addon for VixSrc streaming',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: config.animeUnityEnabled ? ['tt', 'kitsu'] : ['tt'],
  catalogs: []
};

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async (args) => {
  console.log(`Stream request: ${args.type}/${args.id}`);
  
  const allStreams: any[] = [];
  
  // NUOVO: Gestione AnimeUnity per ID Kitsu
  if (config.animeUnityEnabled && args.id.startsWith('kitsu:')) {
    try {
      const animeUnityResult = await animeUnityProvider.handleKitsuRequest(args.id);
      allStreams.push(...animeUnityResult.streams);
    } catch (error) {
      console.error('AnimeUnity error:', error);
    }
  }
  
  // ESISTENTE: Mantieni logica VixSrc per tutti gli altri ID
  if (!args.id.startsWith('kitsu:')) {
    try {
      const vixSrcResult = await extractor(args); // LOGICA ESISTENTE INTATTA
      if (vixSrcResult?.streams) {
        allStreams.push(...vixSrcResult.streams);
      }
    } catch (error) {
      console.error('VixSrc error:', error);
    }
  }
  
  return { streams: allStreams };
});

serveHTTP(builder.getInterface(), { port: config.port });

console.log(`StreamV addon listening on port ${config.port}`);
console.log(`AnimeUnity enabled: ${config.animeUnityEnabled}`);
console.log(`Both links enabled: ${config.bothLink}`);
