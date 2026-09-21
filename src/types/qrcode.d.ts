// Architecture: Shared platform type contract src/types/qrcode.d.ts; provides compile-time shapes used by routes, services, UI and synchronized deployment consumers.
declare module 'qrcode' {
  type QRCodeErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

  export function toDataURL(
    text: string,
    options?: {
      errorCorrectionLevel?: QRCodeErrorCorrectionLevel;
      margin?: number;
      scale?: number;
    }
  ): Promise<string>;

  const _default: {
    toDataURL: typeof toDataURL;
  };
  export default _default;
}
