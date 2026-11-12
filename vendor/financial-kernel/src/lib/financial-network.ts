import {deployment} from '../deployment'
import type {FinancialNetwork} from './merchant-fee-contract'
export type {FinancialNetwork}
export function financialNetwork():FinancialNetwork{return deployment().network}
export function financialHorizonOrigin():string{return financialNetwork()==='Pi Testnet'?'https://api.testnet.minepi.com':'https://api.mainnet.minepi.com'}
export function financialIncomingWallet():string {const p=deployment();return p.schema==='KERNEL_DEPLOYMENT_V2'?p.incomingWallet:p.sourceWallet}
