declare module 'stremio-addon-sdk' {
  export function addonBuilder(manifest: any): any;
  export function getRouter(addonInterface: any): any;
  export function serveHTTP(addonInterface: any, options?: any): void;
  
  export interface Manifest {
    id: string;
    version: string;
    name: string;
    description?: string;
    icon?: string;
    background?: string;
    resources: string[];
    types: string[];
    idPrefixes?: string[];
    catalogs?: any[];
    config?: any[];
    behaviorHints?: any;
    [key: string]: any;
  }

  export interface Stream {
    title?: string;
    name?: string;
    url: string;
    behaviorHints?: any;
    headers?: any;
    [key: string]: any;
  }

  export type ContentType = string | any;
}
