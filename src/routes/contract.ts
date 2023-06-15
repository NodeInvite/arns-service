import { Next } from "koa";

import { KoaContext } from "../types";
import { getContractState } from "../api/warp";
import { getWalletInteractionsForContract } from "../api/graphql";

export async function contractHandler(ctx: KoaContext, next: Next) {
  const { logger, warp } = ctx.state;
  const { id } = ctx.params;

  try {
    logger.debug("Fetching contract state", { id });
    const { state } = await getContractState(id, warp);
    ctx.body = {
      contract: id,
      state,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    logger.error("Failed to fetch contract", { id, error: message });
    ctx.status = 503;
    ctx.body = `Failed to fetch contract: ${id}. ${message}`;
  }
  return next;
}

export async function contractInteractionsHandler(ctx: KoaContext, next: Next) {
  const { arweave, logger, warp } = ctx.state;
  const { id, address } = ctx.params;

  try {
    logger.debug("Fetching all contract interactions", { id });
    const [{ validity, errorMessages }, { interactions }] = await Promise.all([
      getContractState(id, warp),
      getWalletInteractionsForContract(arweave, {
        address: address,
        contractId: id,
      }),
    ]);
    const mappedInteractions = [...interactions.keys()].map((id: string) => {
      const interaction = interactions.get(id);
      if (interaction) {
        return {
          ...interaction,
          valid: validity[id] ?? false,
          ...(errorMessages[id] ? { error: errorMessages[id] } : {}),
          id,
        };
      }
      return;
    });

    // TODO: maybe add a check here that gql and warp returned the same number of interactions
    ctx.body = {
      contract: id,
      interactions: mappedInteractions,
      ...(address ? { address } : {}), // only include address if it was provided
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    logger.error("Failed to fetch contract interactions.", {
      id,
      error: message,
    });
    ctx.status = 503;
    ctx.body = `Failed to fetch contract interactions for contract: ${id}. ${message}`;
  }
  return next;
}

export async function contractFieldHandler(ctx: KoaContext, next: Next) {
  const { id, field } = ctx.params;
  const { logger, warp } = ctx.state;
  try {
    logger.debug("Fetching contract field", { id, field });
    const { state } = await getContractState(id, warp);
    const contractField = state[field];

    if (!contractField) {
      ctx.status = 404;
      ctx.body = "Contract field not found";
      return next;
    }

    ctx.body = {
      contract: id,
      [field]: contractField,
    };
  } catch (error) {
    logger.error("Fetching contract field", { id, field, error });
    ctx.status = 503;
    ctx.body = `Failed to fetch contract: ${id}`;
  }
  return next;
}

export async function contractBalanceHandler(ctx: KoaContext, next: Next) {
  const { id, address } = ctx.params;
  const { logger, warp } = ctx.state;
  try {
    logger.debug("Fetching contract balance for wallet", {
      id,
      wallet: address,
    });
    const { state } = await getContractState(id, warp);
    const balance = state["balances"][address];

    ctx.body = {
      contract: id,
      address,
      balance: balance ?? 0,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    logger.error("Failed to fetch balance.", {
      id,
      wallet: address,
      error: message,
    });
    ctx.status = 503;
    ctx.body = `Failed to fetch balance for wallet ${address}. ${message}`;
  }
  return next;
}

export async function contractRecordHandler(ctx: KoaContext, next: Next) {
  const { id, name } = ctx.params;
  const { logger, warp } = ctx.state;

  try {
    logger.debug("Fetching contract record", { id, record: name });
    const { state } = await getContractState(id, warp);
    const record = state["records"][name];

    if (!record) {
      ctx.status = 404;
      ctx.message = "Record not found";
      return next;
    }

    ctx.body = {
      contract: id,
      name,
      record: record,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    logger.error("Failed to fetch contract record", {
      id,
      record: name,
      error: message,
    });
    ctx.status = 503;
    ctx.body = `Failed to fetch record. ${message}`;
  }
  return next;
}
