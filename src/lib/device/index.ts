/* Surface publique de l'identité d'appareil. E1-03. */

export { DEVICE_STORAGE_KEY, installationId } from '@/lib/device/installation'
export {
  DEVICE_PREFIX_KEY,
  cachedDevicePrefix,
  registerDevice,
  type RegisteredDevice,
} from '@/lib/device/register'
export { useDeviceRegistration } from '@/lib/device/useDeviceRegistration'
