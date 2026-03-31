import { createLogger } from "../core/logger.js";
import type { AppConfig, TradeParams } from "../core/types.js";
import { ClobClient, Side, OrderType as ClobOrderType } from "@polymarket/clob-client";
import { ethers } from "ethers";

const log = createLogger("order-builder");

// Ethers v6 Wallet uses `signTypedData` but the Polymarket SDK expects
// ethers v5's `_signTypedData`. This adapter bridges the two.
function wrapWalletAsSigner(wallet: ethers.Wallet): {
  _signTypedData: (domain: object, types: object, value: object) => Promise<string>;
  getAddress: () => Promise<string>;
} {
  return {
    _signTypedData: (domain, types, value) =>
      wallet.signTypedData(
        domain as ethers.TypedDataDomain,
        types as Record<string, ethers.TypedDataField[]>,
        value as Record<string, unknown>,
      ),
    getAddress: () => Promise.resolve(wallet.address),
  };
}

export class OrderBuilder {
  private readonly config: AppConfig;
  private clobClient: ClobClient | null = null;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    try {
      const provider = new ethers.JsonRpcProvider(this.config.polygonRpcUrl);
      const wallet = new ethers.Wallet(this.config.privateKey, provider);
      const signer = wrapWalletAsSigner(wallet);

      this.clobClient = new ClobClient(
        this.config.polymarketClobUrl,
        this.config.polymarketChainId,
        signer as never, // ClobSigner accepts EthersSigner which matches our shape
        {
          key: this.config.polymarketApiKey,
          secret: this.config.polymarketSecret,
          passphrase: this.config.polymarketPassphrase,
        },
        this.config.signatureType,
        this.config.funderAddress || undefined,
      );

      log.info("Order builder initialized", {
        wallet: this.config.walletAddress,
        chainId: this.config.polymarketChainId,
      });
    } catch (err) {
      log.error("Failed to initialize order builder", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  getClobClient(): ClobClient {
    if (!this.clobClient) {
      throw new Error("OrderBuilder not initialized. Call initialize() first.");
    }
    return this.clobClient;
  }

  async createOrder(params: TradeParams): Promise<unknown> {
    const client = this.getClobClient();
    const side = params.side === "BUY" ? Side.BUY : Side.SELL;

    try {
      const tickSize = await client.getTickSize(params.tokenId);
      const tick = parseFloat(tickSize);
      const roundedPrice = Math.round(params.price / tick) * tick;

      if (params.orderType === "FOK" || params.orderType === "FAK") {
        const marketOrder = await client.createMarketOrder({
          tokenID: params.tokenId,
          amount: params.size,
          side,
          price: roundedPrice,
        });

        log.info("Market order created", {
          tokenId: params.tokenId,
          side: params.side,
          size: params.size,
          price: roundedPrice,
          orderType: params.orderType,
        });

        return marketOrder;
      } else {
        const order = await client.createOrder({
          tokenID: params.tokenId,
          price: roundedPrice,
          size: params.size,
          side,
        });

        log.info("Limit order created", {
          tokenId: params.tokenId,
          side: params.side,
          size: params.size,
          price: roundedPrice,
          orderType: params.orderType,
        });

        return order;
      }
    } catch (err) {
      log.error("Failed to create order", {
        tokenId: params.tokenId,
        side: params.side,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  getOrderType(type: string): ClobOrderType {
    switch (type) {
      case "GTC": return ClobOrderType.GTC;
      case "FOK": return ClobOrderType.FOK;
      case "GTD": return ClobOrderType.GTD;
      case "FAK": return ClobOrderType.FAK;
      default: return ClobOrderType.GTC;
    }
  }
}
