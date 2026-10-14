declare const __APP_VERSION__: string;

/** The version this browser bundle was built from (package.json). */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
