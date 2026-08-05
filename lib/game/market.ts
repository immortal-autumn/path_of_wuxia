import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  MarketContractKind,
  MarketOrderSide,
  MarketSnapshot,
} from "./types";

const DAY_MS = 86_400_000;
const CONTRACT_MULTIPLIER = 10;
const HORIZONS = [1, 7, 30] as const;

const UNDERLYINGS = [
  ["rice", "粳米", "石", 3_500],
  ["tea", "茶饼", "斤", 2_800],
  ["silk", "绫罗", "匹", 8_000],
  ["salt", "食盐", "斤", 750],
  ["wood", "木材", "根", 900],
  ["iron", "铁料", "斤", 1_600],
  ["paper", "楮纸", "刀", 900],
  ["medicine", "药材", "斤", 1_400],
  ["oil", "灯油", "升", 550],
  ["copper", "铜料", "斤", 2_400],
] as const;

type ContractRow = {
  id: string;
  underlying_id: string;
  name: string;
  kind: MarketContractKind;
  expiry_at: string | null;
  horizon_days: number | null;
  strike_wen: number | null;
  multiplier: number;
  mark_price_wen: number;
  status: string;
};

type PositionRow = {
  player_id: string;
  contract_id: string;
  quantity: number;
  average_price_wen: number;
  last_mark_price_wen: number;
};

type OrderRow = {
  rowid: number;
  id: string;
  player_id: string | null;
  owner_kind: "player" | "guild";
  contract_id: string;
  side: MarketOrderSide;
  limit_price_wen: number;
  remaining_quantity: number;
  created_at: string;
};

function minuteKey(at: Date) {
  return at.toISOString().slice(0, 16);
}

function chinaDateToken(at: Date, addDays: number) {
  const china = new Date(at.getTime() + 8 * 60 * 60_000 + addDays * DAY_MS);
  return `${china.getUTCFullYear()}-${String(china.getUTCMonth() + 1).padStart(2, "0")}-${String(china.getUTCDate()).padStart(2, "0")}`;
}

export function marketExpiryAt(at: Date, horizonDays: number) {
  const token = chinaDateToken(at, horizonDays);
  return new Date(`${token}T12:00:00.000Z`).toISOString();
}

function deterministicBasisPoints(key: string) {
  return createHash("sha256").update(key).digest()[0] % 51 - 25;
}

export class MarketEngine {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private ensureAccount(playerId: string, at: string) {
    this.db.prepare(`
      INSERT OR IGNORE INTO market_accounts(
        player_id,reserved_margin_wen,maintenance_margin_wen,clearing_debt_wen,updated_at
      ) VALUES (?,0,0,0,?)
    `).run(playerId, at);
  }

  private wallet(playerId: string) {
    const row = this.db.prepare("SELECT cash_wen FROM player_wallets WHERE player_id=?").get(playerId) as { cash_wen: number } | undefined;
    if (!row) throw new Error("角色钱袋尚未建立。");
    return row.cash_wen;
  }

  private applyCash(playerId: string, deltaWen: number, reason: string, referenceType: string, referenceId: string, at: string) {
    if (!Number.isSafeInteger(deltaWen)) throw new Error("市场结算金额不合法。");
    this.ensureAccount(playerId, at);
    const account = this.db.prepare("SELECT clearing_debt_wen FROM market_accounts WHERE player_id=?").get(playerId) as { clearing_debt_wen: number };
    const cash = this.wallet(playerId);
    let debt = account.clearing_debt_wen;
    const previousDebt = debt;
    let walletDelta = 0;
    if (deltaWen >= 0) {
      const debtPayment = Math.min(debt, deltaWen);
      debt -= debtPayment;
      walletDelta = deltaWen - debtPayment;
    } else {
      const obligation = -deltaWen;
      const paid = Math.min(cash, obligation);
      walletDelta = -paid;
      debt += obligation - paid;
    }
    const nextCash = cash + walletDelta;
    this.db.prepare("UPDATE player_wallets SET cash_wen=?,updated_at=? WHERE player_id=?").run(nextCash, at, playerId);
    this.db.prepare("UPDATE market_accounts SET clearing_debt_wen=?,updated_at=? WHERE player_id=?").run(debt, at, playerId);
    if (debt !== previousDebt) {
      this.db.prepare(`
        INSERT INTO market_account_ledger(
          id,player_id,kind,delta_debt_wen,debt_after_wen,reference_type,reference_id,created_at
        ) VALUES (?,?,?,?,?,?,?,?)
      `).run(
        randomUUID(), playerId, debt > previousDebt ? "debt-created" : "debt-repaid",
        debt - previousDebt, debt, referenceType, referenceId, at,
      );
    }
    if (walletDelta !== 0) {
      this.db.prepare(`
        INSERT INTO currency_ledger(
          id,player_id,delta_wen,balance_after_wen,reason,reference_type,reference_id,created_at
        ) VALUES (?,?,?,?,?,?,?,?)
      `).run(randomUUID(), playerId, walletDelta, nextCash, reason, referenceType, referenceId, at);
    }
  }

  private ensureUnderlyings(at: Date) {
    const minute = minuteKey(at);
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO market_underlyings(
        id,name,unit,spot_price_wen,previous_spot_price_wen,updated_minute,updated_at
      ) VALUES (?,?,?,?,?,?,?)
    `);
    for (const [id, name, unit, price] of UNDERLYINGS) insert.run(id, name, unit, price, price, minute, at.toISOString());
    const rows = this.db.prepare(`
      SELECT id,spot_price_wen,updated_minute FROM market_underlyings ORDER BY id
    `).all() as Array<{ id: string; spot_price_wen: number; updated_minute: string }>;
    const update = this.db.prepare(`
      UPDATE market_underlyings SET previous_spot_price_wen=spot_price_wen,spot_price_wen=?,updated_minute=?,updated_at=? WHERE id=?
    `);
    const tick = this.db.prepare(`
      INSERT OR IGNORE INTO market_ticks(minute_key,underlying_id,spot_price_wen,created_at) VALUES (?,?,?,?)
    `);
    for (const row of rows) {
      let price = row.spot_price_wen;
      if (row.updated_minute !== minute) {
        const bps = deterministicBasisPoints(`${minute}:${row.id}`);
        price = Math.max(1, Math.round((price * (10_000 + bps)) / 10_000));
        update.run(price, minute, at.toISOString(), row.id);
      }
      tick.run(minute, row.id, price, at.toISOString());
    }
  }

  private ensureContracts(at: Date) {
    const underlyings = this.db.prepare(`
      SELECT id,name,spot_price_wen FROM market_underlyings ORDER BY id
    `).all() as Array<{ id: string; name: string; spot_price_wen: number }>;
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO market_contracts(
        id,underlying_id,name,kind,expiry_at,horizon_days,strike_wen,multiplier,mark_price_wen,status,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,'active',?,?)
    `);
    for (const underlying of underlyings) {
      insert.run(
        `spot-${underlying.id}`, underlying.id, `${underlying.name}现货`, "spot", null, null, null, 1,
        underlying.spot_price_wen, at.toISOString(), at.toISOString(),
      );
      for (const horizon of HORIZONS) {
        const activeFuture = this.db.prepare(`
          SELECT 1 FROM market_contracts WHERE underlying_id=? AND kind='future' AND horizon_days=? AND status='active'
        `).get(underlying.id, horizon);
        const expiryAt = marketExpiryAt(at, horizon);
        const expiryToken = expiryAt.slice(0, 10);
        const strike = Math.max(1, Math.round(underlying.spot_price_wen / 10) * 10);
        if (!activeFuture) {
          insert.run(
            `future-${underlying.id}-${horizon}-${expiryToken}`, underlying.id,
            `${underlying.name}${horizon}日期货`, "future", expiryAt, horizon, null, CONTRACT_MULTIPLIER,
            underlying.spot_price_wen, at.toISOString(), at.toISOString(),
          );
        }
        for (const kind of ["call", "put"] as const) {
          const activeOption = this.db.prepare(`
            SELECT 1 FROM market_contracts WHERE underlying_id=? AND kind=? AND horizon_days=? AND status='active'
          `).get(underlying.id, kind, horizon);
          if (!activeOption) {
            insert.run(
              `${kind}-${underlying.id}-${horizon}-${expiryToken}-${strike}`, underlying.id,
              `${underlying.name}${horizon}日${kind === "call" ? "看涨" : "看跌"}${strike}`, kind,
              expiryAt, horizon, strike, CONTRACT_MULTIPLIER, 1, at.toISOString(), at.toISOString(),
            );
          }
        }
      }
    }
  }

  private markFor(contract: ContractRow, spot: number, at: Date) {
    if (contract.kind === "spot") return spot;
    const days = contract.expiry_at ? Math.max(0, (new Date(contract.expiry_at).getTime() - at.getTime()) / DAY_MS) : 0;
    if (contract.kind === "future") return Math.max(1, Math.round(spot * (1 + days * 0.0002)));
    const strike = contract.strike_wen ?? spot;
    const intrinsic = contract.kind === "call" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
    const timeValue = Math.round(spot * 0.08 * Math.sqrt(days / 365));
    return Math.max(1, intrinsic + timeValue);
  }

  private position(playerId: string, contractId: string): PositionRow {
    return (this.db.prepare(`
      SELECT player_id,contract_id,quantity,average_price_wen,last_mark_price_wen
      FROM market_positions WHERE player_id=? AND contract_id=?
    `).get(playerId, contractId) as PositionRow | undefined) ?? {
      player_id: playerId, contract_id: contractId, quantity: 0, average_price_wen: 0, last_mark_price_wen: 0,
    };
  }

  private writePosition(playerId: string, contractId: string, quantity: number, average: number, lastMark: number, at: string) {
    this.db.prepare(`
      INSERT INTO market_positions(player_id,contract_id,quantity,average_price_wen,last_mark_price_wen,updated_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(player_id,contract_id) DO UPDATE SET quantity=excluded.quantity,
        average_price_wen=excluded.average_price_wen,last_mark_price_wen=excluded.last_mark_price_wen,updated_at=excluded.updated_at
    `).run(playerId, contractId, quantity, Math.max(0, average), Math.max(0, lastMark), at);
  }

  private updateSignedPosition(playerId: string, contract: ContractRow, delta: number, price: number, at: string) {
    const position = this.position(playerId, contract.id);
    const oldQuantity = position.quantity;
    const nextQuantity = oldQuantity + delta;
    let average = position.average_price_wen;
    let lastMark = position.last_mark_price_wen || contract.mark_price_wen || price;
    const sameDirection = oldQuantity === 0 || Math.sign(oldQuantity) === Math.sign(delta);
    if (sameDirection) {
      average = Math.round((Math.abs(oldQuantity) * average + Math.abs(delta) * price) / Math.max(1, Math.abs(nextQuantity)));
      lastMark = Math.round((Math.abs(oldQuantity) * lastMark + Math.abs(delta) * price) / Math.max(1, Math.abs(nextQuantity)));
    } else {
      const closed = Math.min(Math.abs(oldQuantity), Math.abs(delta));
      if (contract.kind === "future" && closed > 0) {
        const pnl = (price - lastMark) * closed * Math.sign(oldQuantity) * contract.multiplier;
        this.applyCash(playerId, pnl, "期货平仓损益", "market-contract", contract.id, at);
      }
      if (nextQuantity === 0) {
        average = 0;
        lastMark = 0;
      } else if (Math.sign(nextQuantity) !== Math.sign(oldQuantity)) {
        average = price;
        lastMark = price;
      }
    }
    this.writePosition(playerId, contract.id, nextQuantity, average, lastMark, at);
  }

  private risk(playerId: string) {
    const positions = this.db.prepare(`
      SELECT position.quantity,contract.kind,contract.multiplier,contract.mark_price_wen,underlying.spot_price_wen
      FROM market_positions position JOIN market_contracts contract ON contract.id=position.contract_id
      JOIN market_underlyings underlying ON underlying.id=contract.underlying_id
      WHERE position.player_id=? AND position.quantity<>0 AND contract.status='active'
    `).all(playerId) as Array<{
      quantity: number; kind: MarketContractKind; multiplier: number; mark_price_wen: number; spot_price_wen: number;
    }>;
    let initial = 0;
    let maintenance = 0;
    for (const position of positions) {
      if (position.kind === "future") {
        const notional = Math.abs(position.quantity) * position.multiplier * position.mark_price_wen;
        initial += Math.ceil(notional * 0.2);
        maintenance += Math.ceil(notional * 0.1);
      } else if ((position.kind === "call" || position.kind === "put") && position.quantity < 0) {
        const notional = Math.abs(position.quantity) * position.multiplier * position.spot_price_wen;
        initial += Math.ceil(notional * 0.25);
        maintenance += Math.ceil(notional * 0.15);
      }
    }
    return { initial, maintenance };
  }

  private openOrderReserve(playerId: string) {
    const orders = this.db.prepare(`
      SELECT order_row.side,order_row.limit_price_wen,order_row.remaining_quantity,
        contract.kind,contract.multiplier,contract.mark_price_wen,underlying.spot_price_wen
      FROM market_orders order_row JOIN market_contracts contract ON contract.id=order_row.contract_id
      JOIN market_underlyings underlying ON underlying.id=contract.underlying_id
      WHERE order_row.player_id=? AND order_row.status='open' AND order_row.remaining_quantity>0
    `).all(playerId) as Array<{
      side: MarketOrderSide; limit_price_wen: number; remaining_quantity: number;
      kind: MarketContractKind; multiplier: number; mark_price_wen: number; spot_price_wen: number;
    }>;
    return orders.reduce((sum, order) => {
      if (order.kind === "spot") {
        return sum + (order.side === "buy" ? order.limit_price_wen * order.remaining_quantity : 0);
      }
      if ((order.kind === "call" || order.kind === "put") && order.side === "buy") {
        return sum + order.limit_price_wen * order.multiplier * order.remaining_quantity;
      }
      if (order.kind === "future") {
        return sum + Math.ceil(order.mark_price_wen * order.multiplier * order.remaining_quantity * 0.2);
      }
      return sum + Math.ceil(order.spot_price_wen * order.multiplier * order.remaining_quantity * 0.25);
    }, 0);
  }

  private updateRisk(playerId: string, at: string) {
    this.ensureAccount(playerId, at);
    const risk = this.risk(playerId);
    const orderReserve = this.openOrderReserve(playerId);
    this.db.prepare(`
      UPDATE market_accounts SET reserved_margin_wen=?,maintenance_margin_wen=?,updated_at=? WHERE player_id=?
    `).run(risk.initial + orderReserve, risk.maintenance, at, playerId);
    return { initial: risk.initial + orderReserve, maintenance: risk.maintenance };
  }

  private markContracts(at: Date) {
    const contracts = this.db.prepare(`
      SELECT id,underlying_id,name,kind,expiry_at,horizon_days,strike_wen,multiplier,mark_price_wen,status
      FROM market_contracts WHERE status='active' ORDER BY id
    `).all() as ContractRow[];
    const spotRows = this.db.prepare("SELECT id,spot_price_wen FROM market_underlyings").all() as Array<{ id: string; spot_price_wen: number }>;
    const spots = new Map(spotRows.map((row) => [row.id, row.spot_price_wen]));
    const updateContract = this.db.prepare("UPDATE market_contracts SET mark_price_wen=?,updated_at=? WHERE id=?");
    const futurePositions = this.db.prepare(`
      SELECT player_id,contract_id,quantity,average_price_wen,last_mark_price_wen
      FROM market_positions WHERE contract_id=? AND quantity<>0
    `);
    for (const contract of contracts) {
      const mark = this.markFor(contract, spots.get(contract.underlying_id) ?? contract.mark_price_wen, at);
      if (contract.kind === "future") {
        for (const position of futurePositions.all(contract.id) as PositionRow[]) {
          const anchor = position.last_mark_price_wen || position.average_price_wen || contract.mark_price_wen;
          const pnl = (mark - anchor) * position.quantity * contract.multiplier;
          if (pnl) this.applyCash(position.player_id, pnl, "期货逐分钟盯市", "market-contract", contract.id, at.toISOString());
          this.writePosition(position.player_id, contract.id, position.quantity, mark, mark, at.toISOString());
        }
      }
      updateContract.run(mark, at.toISOString(), contract.id);
    }
  }

  private settleExpired(at: Date) {
    const contracts = this.db.prepare(`
      SELECT contract.id,contract.underlying_id,contract.name,contract.kind,contract.expiry_at,
        contract.horizon_days,contract.strike_wen,contract.multiplier,contract.mark_price_wen,contract.status,
        underlying.spot_price_wen
      FROM market_contracts contract JOIN market_underlyings underlying ON underlying.id=contract.underlying_id
      WHERE contract.status='active' AND contract.expiry_at IS NOT NULL AND contract.expiry_at<=?
      ORDER BY contract.expiry_at,contract.id
    `).all(at.toISOString()) as Array<ContractRow & { spot_price_wen: number }>;
    for (const contract of contracts) {
      const positions = this.db.prepare(`
        SELECT player_id,contract_id,quantity,average_price_wen,last_mark_price_wen
        FROM market_positions WHERE contract_id=? AND quantity<>0
      `).all(contract.id) as PositionRow[];
      const intrinsic = contract.kind === "call"
        ? Math.max(0, contract.spot_price_wen - (contract.strike_wen ?? contract.spot_price_wen))
        : contract.kind === "put"
          ? Math.max(0, (contract.strike_wen ?? contract.spot_price_wen) - contract.spot_price_wen)
          : 0;
      for (const position of positions) {
        if (contract.kind === "call" || contract.kind === "put") {
          const settlement = intrinsic * contract.multiplier * position.quantity;
          if (settlement) this.applyCash(position.player_id, settlement, "欧式期权到期现金结算", "market-contract", contract.id, at.toISOString());
        }
        this.writePosition(position.player_id, contract.id, 0, 0, 0, at.toISOString());
      }
      this.db.prepare("UPDATE market_orders SET status='expired',remaining_quantity=0,updated_at=? WHERE contract_id=? AND status='open'")
        .run(at.toISOString(), contract.id);
      this.db.prepare("UPDATE market_contracts SET status='settled',mark_price_wen=?,updated_at=? WHERE id=?")
        .run(contract.kind === "future" ? contract.spot_price_wen : intrinsic, at.toISOString(), contract.id);
    }
  }

  private liquidateIfNeeded(playerId: string, at: string) {
    const risk = this.updateRisk(playerId, at);
    if (risk.maintenance === 0 || this.wallet(playerId) >= risk.maintenance) return;
    const positions = this.db.prepare(`
      SELECT position.player_id,position.contract_id,position.quantity,position.average_price_wen,position.last_mark_price_wen,
        contract.kind,contract.mark_price_wen,contract.multiplier
      FROM market_positions position JOIN market_contracts contract ON contract.id=position.contract_id
      WHERE position.player_id=? AND position.quantity<>0 AND contract.status='active'
        AND (contract.kind='future' OR (contract.kind IN ('call','put') AND position.quantity<0))
      ORDER BY contract.kind,contract.id
    `).all(playerId) as Array<PositionRow & { kind: MarketContractKind; mark_price_wen: number; multiplier: number }>;
    for (const position of positions) {
      if ((position.kind === "call" || position.kind === "put") && position.quantity < 0) {
        this.applyCash(
          playerId,
          -position.mark_price_wen * position.multiplier * Math.abs(position.quantity),
          "期权空头强制平仓",
          "market-liquidation",
          position.contract_id,
          at,
        );
      }
      this.db.prepare(`
        INSERT INTO market_liquidations(id,player_id,contract_id,quantity,price_wen,reason,created_at)
        VALUES (?,?,?,?,?,'低于维持保证金',?)
      `).run(randomUUID(), playerId, position.contract_id, -position.quantity, position.mark_price_wen, at);
      this.writePosition(playerId, position.contract_id, 0, 0, 0, at);
    }
    this.db.prepare("UPDATE market_orders SET status='cancelled',remaining_quantity=0,updated_at=? WHERE player_id=? AND status='open'")
      .run(at, playerId);
    this.updateRisk(playerId, at);
  }

  private guildQuotes(at: Date) {
    const minute = minuteKey(at);
    this.db.prepare(`
      UPDATE market_orders SET status='cancelled',remaining_quantity=0,updated_at=?
      WHERE owner_kind='guild' AND status='open' AND request_id<>?
    `).run(at.toISOString(), `guild:${minute}`);
    this.db.prepare(`
      DELETE FROM market_orders
      WHERE owner_kind='guild' AND status='cancelled'
        AND NOT EXISTS (
          SELECT 1 FROM market_trades trade
          WHERE trade.buy_order_id=market_orders.id OR trade.sell_order_id=market_orders.id
        )
    `).run();
    const contracts = this.db.prepare(`
      SELECT id,underlying_id,name,kind,expiry_at,horizon_days,strike_wen,multiplier,mark_price_wen,status
      FROM market_contracts WHERE status='active' ORDER BY id
    `).all() as ContractRow[];
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO market_orders(
        id,request_id,player_id,owner_kind,contract_id,side,limit_price_wen,quantity,remaining_quantity,
        status,payload_hash,created_at,updated_at
      ) VALUES (?, ?,NULL,'guild',?,?,?,?,?,'open',?,?,?)
    `);
    for (const contract of contracts) {
      const bid = Math.max(1, Math.floor(contract.mark_price_wen * 0.995));
      const ask = Math.max(bid + 1, Math.ceil(contract.mark_price_wen * 1.005));
      for (const [side, price] of [["buy", bid], ["sell", ask]] as const) {
        const id = `guild-${minute}-${contract.id}-${side}`;
        insert.run(id, `guild:${minute}`, contract.id, side, price, 100, 100, id, at.toISOString(), at.toISOString());
      }
    }
  }

  private contract(contractId: string) {
    const row = this.db.prepare(`
      SELECT id,underlying_id,name,kind,expiry_at,horizon_days,strike_wen,multiplier,mark_price_wen,status
      FROM market_contracts WHERE id=?
    `).get(contractId) as ContractRow | undefined;
    if (!row || row.status !== "active") throw new Error("合约不存在或已经到期。");
    return row;
  }

  private applyTrade(contract: ContractRow, buy: OrderRow, sell: OrderRow, price: number, quantity: number, at: string) {
    const total = price * contract.multiplier * quantity;
    if (!Number.isSafeInteger(total)) throw new Error("成交金额超出范围。");
    if (contract.kind === "spot") {
      if (buy.player_id) {
        if (this.wallet(buy.player_id) < total) throw new Error("买方钱贯不足。");
        this.applyCash(buy.player_id, -total, "现货买入", "market-contract", contract.id, at);
        this.updateSignedPosition(buy.player_id, contract, quantity, price, at);
      }
      if (sell.player_id) {
        const position = this.position(sell.player_id, contract.id);
        if (position.quantity < quantity) throw new Error("卖方现货持仓不足。");
        this.updateSignedPosition(sell.player_id, contract, -quantity, price, at);
        this.applyCash(sell.player_id, total, "现货卖出", "market-contract", contract.id, at);
      }
    } else if (contract.kind === "future") {
      if (buy.player_id) this.updateSignedPosition(buy.player_id, contract, quantity, price, at);
      if (sell.player_id) this.updateSignedPosition(sell.player_id, contract, -quantity, price, at);
    } else {
      if (buy.player_id) {
        if (this.wallet(buy.player_id) < total) throw new Error("买方权利金不足。");
        this.applyCash(buy.player_id, -total, "期权权利金支出", "market-contract", contract.id, at);
        this.updateSignedPosition(buy.player_id, contract, quantity, price, at);
      }
      if (sell.player_id) {
        this.applyCash(sell.player_id, total, "期权权利金收入", "market-contract", contract.id, at);
        this.updateSignedPosition(sell.player_id, contract, -quantity, price, at);
      }
    }
    this.db.prepare(`
      UPDATE market_orders SET remaining_quantity=remaining_quantity-?,
        status=CASE WHEN remaining_quantity-?=0 THEN 'filled' ELSE 'open' END,updated_at=? WHERE id=?
    `).run(quantity, quantity, at, buy.id);
    this.db.prepare(`
      UPDATE market_orders SET remaining_quantity=remaining_quantity-?,
        status=CASE WHEN remaining_quantity-?=0 THEN 'filled' ELSE 'open' END,updated_at=? WHERE id=?
    `).run(quantity, quantity, at, sell.id);
    this.db.prepare(`
      INSERT INTO market_trades(
        contract_id,buy_order_id,sell_order_id,buyer_player_id,seller_player_id,price_wen,quantity,created_at
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(contract.id, buy.id, sell.id, buy.player_id, sell.player_id, price, quantity, at);
    for (const playerId of [buy.player_id, sell.player_id]) {
      if (!playerId) continue;
      const risk = this.updateRisk(playerId, at);
      if (this.wallet(playerId) < risk.initial) throw new Error("成交后的初始保证金不足。");
    }
  }

  private matchContract(contractId: string, at: Date) {
    const contract = this.contract(contractId);
    for (let guard = 0; guard < 1_000; guard += 1) {
      const buy = this.db.prepare(`
        SELECT rowid,id,player_id,owner_kind,contract_id,side,limit_price_wen,remaining_quantity,created_at
        FROM market_orders WHERE contract_id=? AND side='buy' AND status='open' AND remaining_quantity>0
        ORDER BY limit_price_wen DESC,created_at,rowid LIMIT 1
      `).get(contractId) as OrderRow | undefined;
      const sell = this.db.prepare(`
        SELECT rowid,id,player_id,owner_kind,contract_id,side,limit_price_wen,remaining_quantity,created_at
        FROM market_orders WHERE contract_id=? AND side='sell' AND status='open' AND remaining_quantity>0
        ORDER BY limit_price_wen ASC,created_at,rowid LIMIT 1
      `).get(contractId) as OrderRow | undefined;
      if (!buy || !sell || buy.limit_price_wen < sell.limit_price_wen) break;
      if (buy.player_id && buy.player_id === sell.player_id) {
        const newer = buy.rowid > sell.rowid ? buy : sell;
        this.db.prepare("UPDATE market_orders SET status='cancelled',remaining_quantity=0,updated_at=? WHERE id=?")
          .run(at.toISOString(), newer.id);
        continue;
      }
      const price = buy.rowid < sell.rowid ? buy.limit_price_wen : sell.limit_price_wen;
      const quantity = Math.min(buy.remaining_quantity, sell.remaining_quantity);
      this.applyTrade(contract, buy, sell, price, quantity, at.toISOString());
    }
  }

  settle() {
    const at = this.now();
    this.ensureUnderlyings(at);
    this.settleExpired(at);
    this.ensureContracts(at);
    this.markContracts(at);
    this.guildQuotes(at);
    const activeContracts = this.db.prepare("SELECT id FROM market_contracts WHERE status='active'").all() as Array<{ id: string }>;
    for (const contract of activeContracts) this.matchContract(contract.id, at);
    const accounts = this.db.prepare("SELECT player_id FROM market_accounts").all() as Array<{ player_id: string }>;
    for (const account of accounts) this.liquidateIfNeeded(account.player_id, at.toISOString());
  }

  private assertCapacity(playerId: string, contract: ContractRow, side: MarketOrderSide, price: number, quantity: number) {
    const wallet = this.wallet(playerId);
    const position = this.position(playerId, contract.id);
    const openSameSide = (this.db.prepare(`
      SELECT COALESCE(SUM(remaining_quantity),0) AS quantity FROM market_orders
      WHERE player_id=? AND contract_id=? AND side=? AND status='open'
    `).get(playerId, contract.id, side) as { quantity: number }).quantity;
    const totalQuantity = quantity + openSameSide;
    const alreadyReserved = this.risk(playerId).initial + this.openOrderReserve(playerId);
    if (contract.kind === "spot") {
      if (side === "buy" && alreadyReserved + price * quantity > wallet) throw new Error("现货买单所需钱贯不足。");
      if (side === "sell" && totalQuantity > position.quantity) throw new Error("现货卖单超过可用持仓。");
      return;
    }
    if ((contract.kind === "call" || contract.kind === "put") && side === "buy"
      && alreadyReserved + price * contract.multiplier * quantity > wallet) {
      throw new Error("期权买单所需权利金不足。");
    }
    let newOrderReserve = 0;
    if (contract.kind === "future") {
      const projected = position.quantity + (side === "buy" ? quantity : -quantity);
      const currentRisk = Math.ceil(Math.abs(position.quantity) * contract.multiplier * contract.mark_price_wen * 0.2);
      const projectedRisk = Math.ceil(Math.abs(projected) * contract.multiplier * contract.mark_price_wen * 0.2);
      newOrderReserve = Math.max(0, projectedRisk - currentRisk);
    } else if (contract.kind === "call" || contract.kind === "put") {
      const spot = (this.db.prepare("SELECT spot_price_wen FROM market_underlyings WHERE id=?").get(contract.underlying_id) as { spot_price_wen: number }).spot_price_wen;
      if (side === "sell") {
        const projected = position.quantity - quantity;
        const currentRisk = position.quantity < 0 ? Math.ceil(Math.abs(position.quantity) * contract.multiplier * spot * 0.25) : 0;
        const projectedRisk = projected < 0 ? Math.ceil(Math.abs(projected) * contract.multiplier * spot * 0.25) : 0;
        newOrderReserve = Math.max(0, projectedRisk - currentRisk);
      }
    }
    if (wallet < alreadyReserved + newOrderReserve) throw new Error("订单所需初始保证金不足。");
  }

  snapshot(playerId: string, settleMarket = true): MarketSnapshot {
    this.ensureAccount(playerId, this.now().toISOString());
    if (settleMarket) this.settle();
    this.updateRisk(playerId, this.now().toISOString());
    const underlyings = this.db.prepare(`
      SELECT id,name,unit,spot_price_wen,previous_spot_price_wen FROM market_underlyings ORDER BY id
    `).all() as Array<{ id: string; name: string; unit: string; spot_price_wen: number; previous_spot_price_wen: number }>;
    const contracts = this.db.prepare(`
      SELECT contract.id,contract.underlying_id,contract.name,contract.kind,contract.expiry_at,contract.horizon_days,
        contract.strike_wen,contract.multiplier,contract.mark_price_wen,
        (SELECT MAX(limit_price_wen) FROM market_orders WHERE contract_id=contract.id AND side='buy' AND status='open') AS best_bid,
        (SELECT MIN(limit_price_wen) FROM market_orders WHERE contract_id=contract.id AND side='sell' AND status='open') AS best_ask
      FROM market_contracts contract WHERE contract.status='active'
      ORDER BY contract.underlying_id,contract.kind,contract.horizon_days,contract.strike_wen
    `).all() as Array<{
      id: string; underlying_id: string; name: string; kind: MarketContractKind; expiry_at: string | null;
      horizon_days: number | null; strike_wen: number | null; multiplier: number; mark_price_wen: number;
      best_bid: number | null; best_ask: number | null;
    }>;
    const orders = this.db.prepare(`
      SELECT id,contract_id,side,limit_price_wen,quantity,remaining_quantity,status,created_at
      FROM market_orders WHERE player_id=? AND status IN ('open','partially-filled') ORDER BY created_at,id
    `).all(playerId) as Array<{
      id: string; contract_id: string; side: MarketOrderSide; limit_price_wen: number;
      quantity: number; remaining_quantity: number; status: string; created_at: string;
    }>;
    const positions = this.db.prepare(`
      SELECT position.contract_id,position.quantity,position.average_price_wen,contract.name,contract.kind,
        contract.mark_price_wen,contract.multiplier
      FROM market_positions position JOIN market_contracts contract ON contract.id=position.contract_id
      WHERE position.player_id=? AND position.quantity<>0 ORDER BY contract.underlying_id,contract.kind,contract.id
    `).all(playerId) as Array<{
      contract_id: string; quantity: number; average_price_wen: number; name: string;
      kind: MarketContractKind; mark_price_wen: number; multiplier: number;
    }>;
    const trades = this.db.prepare(`
      SELECT id,contract_id,price_wen,quantity,created_at FROM market_trades
      WHERE buyer_player_id=? OR seller_player_id=? ORDER BY id DESC LIMIT 30
    `).all(playerId, playerId) as Array<{ id: number; contract_id: string; price_wen: number; quantity: number; created_at: string }>;
    const account = this.db.prepare(`
      SELECT reserved_margin_wen,maintenance_margin_wen,clearing_debt_wen FROM market_accounts WHERE player_id=?
    `).get(playerId) as { reserved_margin_wen: number; maintenance_margin_wen: number; clearing_debt_wen: number };
    return {
      asOf: this.now().toISOString(),
      underlyings: underlyings.map((row) => ({
        id: row.id, name: row.name, unit: row.unit, spotPriceWen: row.spot_price_wen,
        previousSpotPriceWen: row.previous_spot_price_wen,
      })),
      contracts: contracts.map((row) => ({
        id: row.id, underlyingId: row.underlying_id, name: row.name, kind: row.kind,
        expiryAt: row.expiry_at, horizonDays: row.horizon_days, strikeWen: row.strike_wen,
        multiplier: row.multiplier, markPriceWen: row.mark_price_wen,
        bestBidWen: row.best_bid, bestAskWen: row.best_ask,
      })),
      orders: orders.map((row) => ({
        id: row.id, contractId: row.contract_id, side: row.side, limitPriceWen: row.limit_price_wen,
        quantity: row.quantity, remainingQuantity: row.remaining_quantity, status: row.status, createdAt: row.created_at,
      })),
      positions: positions.map((row) => ({
        contractId: row.contract_id, contractName: row.name, kind: row.kind, quantity: row.quantity,
        averagePriceWen: row.average_price_wen, markPriceWen: row.mark_price_wen,
        unrealizedPnlWen: (row.mark_price_wen - row.average_price_wen) * row.quantity * row.multiplier,
      })),
      trades: trades.map((row) => ({ id: row.id, contractId: row.contract_id, priceWen: row.price_wen, quantity: row.quantity, createdAt: row.created_at })),
      reservedMarginWen: account.reserved_margin_wen,
      maintenanceMarginWen: account.maintenance_margin_wen,
      clearingDebtWen: account.clearing_debt_wen,
    };
  }

  placeOrder(
    playerId: string,
    requestId: string,
    contractId: string,
    side: MarketOrderSide,
    limitPriceWen: number,
    quantity: number,
  ) {
    this.ensureAccount(playerId, this.now().toISOString());
    this.settle();
    const account = this.db.prepare("SELECT clearing_debt_wen FROM market_accounts WHERE player_id=?")
      .get(playerId) as { clearing_debt_wen: number };
    if (account.clearing_debt_wen > 0) throw new Error("清算债务偿清前不能提交新订单。");
    const payloadHash = createHash("sha256").update(JSON.stringify({ contractId, side, limitPriceWen, quantity })).digest("hex");
    const existing = this.db.prepare("SELECT id,payload_hash FROM market_orders WHERE player_id=? AND request_id=?")
      .get(playerId, requestId) as { id: string; payload_hash: string } | undefined;
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw new Error("同一请求编号不能用于不同的市场订单。");
      return { market: this.snapshot(playerId), message: "这笔市场订单已经提交。" };
    }
    const contract = this.contract(contractId);
    this.assertCapacity(playerId, contract, side, limitPriceWen, quantity);
    const at = this.now().toISOString();
    const orderId = randomUUID();
    this.db.prepare(`
      INSERT INTO market_orders(
        id,request_id,player_id,owner_kind,contract_id,side,limit_price_wen,quantity,remaining_quantity,
        status,payload_hash,created_at,updated_at
      ) VALUES (?,?,?,'player',?,?,?,?,?,'open',?,?,?)
    `).run(orderId, requestId, playerId, contractId, side, limitPriceWen, quantity, quantity, payloadHash, at, at);
    this.matchContract(contractId, this.now());
    const risk = this.updateRisk(playerId, at);
    if (this.wallet(playerId) < risk.initial) throw new Error("订单成交后的初始保证金不足。");
    const order = this.db.prepare("SELECT status,remaining_quantity FROM market_orders WHERE id=?").get(orderId) as { status: string; remaining_quantity: number };
    return {
      market: this.snapshot(playerId),
      message: order.remaining_quantity === 0 ? "市场订单已经全部成交。" : order.status === "open" ? "市场限价单已进入订单簿。" : "市场订单已经部分成交。",
    };
  }

  cancelOrder(playerId: string, requestId: string, orderId: string) {
    this.settle();
    const payloadHash = createHash("sha256").update(JSON.stringify({ orderId })).digest("hex");
    const replay = this.db.prepare(`
      SELECT order_id,payload_hash FROM market_order_cancellations WHERE player_id=? AND request_id=?
    `).get(playerId, requestId) as { order_id: string; payload_hash: string } | undefined;
    if (replay) {
      if (replay.order_id !== orderId || replay.payload_hash !== payloadHash) {
        throw new Error("同一请求编号不能取消不同的市场订单。");
      }
      return { market: this.snapshot(playerId), message: "这笔市场订单已经取消。" };
    }
    const changed = this.db.prepare(`
      UPDATE market_orders SET status='cancelled',remaining_quantity=0,updated_at=?
      WHERE id=? AND player_id=? AND status='open'
    `).run(this.now().toISOString(), orderId, playerId);
    if (changed.changes !== 1) throw new Error("订单不存在或已经不能取消。");
    this.db.prepare(`
      INSERT INTO market_order_cancellations(id,player_id,request_id,order_id,payload_hash,created_at)
      VALUES (?,?,?,?,?,?)
    `).run(randomUUID(), playerId, requestId, orderId, payloadHash, this.now().toISOString());
    this.updateRisk(playerId, this.now().toISOString());
    return { market: this.snapshot(playerId), message: "市场订单已取消。" };
  }
}
