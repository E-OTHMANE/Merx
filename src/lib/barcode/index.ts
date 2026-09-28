/* Surface publique de la lecture et du dessin des codes-barres. E2-06. */

export { Code128 } from '@/lib/barcode/Code128'
export { ScanButton } from '@/lib/barcode/ScanButton'
export { code128Width, encodeCode128 } from '@/lib/barcode/encode'
export type { Code128 as Code128Value } from '@/lib/barcode/encode'
export {
  SCANNED_FORMATS,
  cameraScanningAvailable,
  startScanning,
  type ScanSession,
} from '@/lib/barcode/scanner'
