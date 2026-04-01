import { ethers } from "ethers";
import { ClobClient, Side } from "@polymarket/clob-client";
import type { SignedOrder } from "@polymarket/clob-client";
import { createLogger } from "../core/logger.js";
import type { AppConfig, TradeParams } from "../core/types.js";

const log = createLogger("order-builder");

// Adapter: ethers v6 Wallet uses signTypedData, but the Polymarket SDK
// expects the ethers v5 interface (_signTypedData + getAddress returning Promise).
function wrapWalletForClob(wallet: ethers.Wallet): {
  _signTypedData: (
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ) => Promise<string>;
  getAddress: () => Promise<string>;
} {
  return {
    _signTypedData: (domain, types, value) =>
      wallet.signTypedData(
        domain as ethers.TypedDataDomain,
        types as Record<string, ethers.TypedDataField[]>,
        value,
      ),
    getAddress: () => Promise.resolve(wallet.address),
  };
}

export class OrderBuilder {
  private readonly config: AppConfig;
  private client: ClobClient | null = null;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    try {
      const wallet = new ethers.Wallet(this.config.privateKey);
      const signer = wrapWalletForClob(wallet);

      this.client = new ClobClient(
        this.config.polymarketClobUrl,
        this.config.polymarketChainId,
        signer,
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

  async createOrder(params: TradeParams): Promise<{ signedOrder: SignedOrder; orderType: string }> {
    if (!this.client) {
      throw new Error("Order builder not initialized");
    }

    // Get tick size and round price to valid tick
    const tickSizeStr = await this.client.getTickSize(params.tokenId);
    const tick = parseFloat(tickSizeStr);
    const roundedPrice = Number.isFinite(tick) && tick > 0
      ? Math.round(params.price / tick) * tick
      : params.price;

    const side = params.side === "BUY" ? Side.BUY : Side.SELL;

    // For FOK/FAK (market orders), use createMarketOrder
    if (params.orderType === "FOK" || params.orderType === "FAK") {
      log.info("Creating market order", {
        tokenId: params.tokenId,
        side: params.side,
        size: params.size,
        price: roundedPrice,
        orderType: params.orderType,
      });

      const signedOrder = await this.client.createMarketOrder({
        tokenID: params.tokenId,
        amount: params.size,
        side,
        price: roundedPrice,
      });

      return { signedOrder, orderType: params.orderType };
    }

    // For GTC/GTD (limit orders), use createOrder
    log.info("Creating limit order", {
      tokenId: params.tokenId,
      side: params.side,
      price: roundedPrice,
      size: params.size,
      orderType: params.orderType,
    });

    const signedOrder = await this.client.createOrder({
      tokenID: params.tokenId,
      price: roundedPrice,
      size: params.size,
      side,
    });

    return { signedOrder, orderType: params.orderType };
  }

  getClient(): ClobClient | null {
    return this.client;
  }
}
