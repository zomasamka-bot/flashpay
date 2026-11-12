/** Active execution stays on the historical zero-commission Testnet contract.
 * Prepared policies cannot grant authority or silently reprice an old payment.
 */
export function isLegacyZeroCommission(gross: unknown, net: unknown, commission: unknown): boolean {
  return typeof gross === 'number' && Number.isFinite(gross) && gross > 0 &&
    typeof net === 'number' && Number.isFinite(net) && net === gross && commission === 0
}
export function assertActiveNetworkConfiguration(network: string, publicNetwork: string | undefined): void {
  if (network !== 'Pi Testnet' && network !== 'Pi Network') throw Error('NETWORK_ACTIVATION_NOT_QUALIFIED')
  if (network === 'Pi Network' ? publicNetwork !== 'mainnet' : publicNetwork !== undefined && publicNetwork !== '' && publicNetwork !== 'testnet') throw Error('NETWORK_PUBLIC_CONFIGURATION_MISMATCH')
}
