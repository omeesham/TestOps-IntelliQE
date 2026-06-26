/**
 * Ambient declaration for `app-info-parser` (no bundled types).
 * The parser returns format-specific shapes (APK manifest vs IPA Info.plist),
 * so we treat results as `any` and normalise them in mobile-app-parser.service.ts.
 */
declare module 'app-info-parser' {
  export default class AppInfoParser {
    constructor(file: string | Buffer | ArrayBuffer | File);
    parse(): Promise<any>;
  }
}
