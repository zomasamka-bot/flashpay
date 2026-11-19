# FLASHpay

Merchant payment requests, settlement, eligible refunds and receipts on Pi Testnet.

## Open the app

**Live application:** [https://flashpay-two.vercel.app](https://flashpay-two.vercel.app)

Open this address in **Pi Browser** for Pi authentication and wallet approval. The deployed application currently uses **Testnet / Test-Pi**, not Mainnet or real Pi.

**Source repository:** [zomasamka-bot/flashpay](https://github.com/zomasamka-bot/flashpay)

## Merchant features

- Create payment requests with a QR code or a shareable link, suitable for in-store, remote and delivery orders.
- Track merchant settlement and eligible automatic refunds.
- View payment and refund receipts, sales history and merchant summaries; export CSV and download or share receipts.
- Use the interface in English, Arabic, Spanish, Hindi, Russian, Vietnamese or Chinese.

The financial core checks payment identity, amounts and finality, guards against duplicate execution, and supports recovery of eligible unfinished operations with durable accounting records. These controls do not constitute a third-party audit or a guarantee of availability.

## Review notes

The live Vercel application is the reference runtime for this repository. A separate Pi App Studio preview may differ in configuration and connected services; please review the live address above in Pi Browser.

This repository contains application source. Production credentials and private operational evidence must not be added here. Running the full financial workflow requires the configured database, trust services and Pi application credentials; a frontend-only preview is insufficient.

- [Privacy policy](https://flashpay-two.vercel.app/privacy)
- [Terms](https://flashpay-two.vercel.app/terms)

Developed by Hazem Abo Ria. FLASHpay is an independent application and is not an official Pi Network product.

## License

The FLASHpay-owned application and financial-kernel source in this repository are licensed under the [PiOS License](LICENSE), Copyright (C) 2026 Hazem Abo Ria. PiOS permits reuse and derivative works for the official Pi Network subject to its terms. Third-party dependencies retain their respective licenses. Credentials and private operational evidence are not part of this public source distribution.

Pi, Pi Network and the Pi logo are trademarks of the Pi Community Company.

