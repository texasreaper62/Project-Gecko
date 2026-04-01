import { ethers } from "ethers";
import { createLogger } from "../core/logger.js";
import type { AppConfig } from "../core/types.js";
import type { RiskManager } from "../execution/risk-manager.js";

const log = createLogger("wallet-monitor");

// USDC.e on Polygon
const USDC_E_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_E_DECIMALS = 6;

// ERC20 balanceOf ABI fragment
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

// Check every 60 seconds
const CHECK_INTERVAL = 60_000;
// Kill switch if balance drops below 10% of starting
const KILL_THRESHOLD_PERCENT = 10;

export class WalletMonitor {
  private readonly config: AppConfig;
  private readonly riskManager: RiskManager;
  private provider: ethers.JsonRpcProvider | null = null;
  private contract: ethers.Contract | null = null;
  private startingBalance: number | null = null;
  private currentBalance = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AppConfig, riskManager: RiskManager) {
    this.config = config;
    this.riskManager = riskManager;
  }

  async start(): Promise<void> {
    try {
      this.provider = new ethers.JsonRpcProvider(this.config.polygonRpcUrl);
      this.contract = new ethers.Contract(USDC_E_ADDRESS, ERC20_ABI, this.provider);

      // Get starting balance
      this.startingBalance = await this.queryBalance();
      this.currentBalance = this.startingBalance;

      log.info("Wallet monitor started", {
        wallet: this.config.walletAddress,
        balance: this.startingBalance.toFixed(2),
      });

      this.timer = setInterval(() => {
        this.checkBalance().catch((err) => {
          log.error("Balance check error", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, CHECK_INTERVAL);
    } catch (err) {
      log.error("Failed to start wallet monitor", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.provider?.destroy();
  }

  getBalance(): number {
    return this.currentBalance;
  }

  getStartingBalance(): number {
    return this.startingBalance ?? 0;
  }

  private async checkBalance(): Promise<void> {
    const balance = await this.queryBalance();
    this.currentBalance = balance;

    // Auto-kill if balance drops below threshold
    if (this.startingBalance !== null && this.startingBalance > 0) {
      const percentRemaining = (balance / this.startingBalance) * 100;

      if (percentRemaining < KILL_THRESHOLD_PERCENT) {
        this.riskManager.activateKillSwitch(
          `Wallet balance dropped to $${balance.toFixed(2)} ` +
          `(${percentRemaining.toFixed(1)}% of starting $${this.startingBalance.toFixed(2)})`
        );
      }
    }

    log.debug("Balance checked", { balance: balance.toFixed(2) });
  }

  private async queryBalance(): Promise<number> {
    if (!this.contract) throw new Error("Contract not initialized");

    const raw: bigint = await this.contract.balanceOf(this.config.walletAddress);
    return Number(raw) / Math.pow(10, USDC_E_DECIMALS);
  }
}
