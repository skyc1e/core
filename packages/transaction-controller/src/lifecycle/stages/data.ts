import type { Hex } from '@metamask/utils';
import { cloneDeep } from 'lodash';

import { projectLogger as log } from '../../logger';
import type {
  AddTransactionOptions,
  TransactionContext,
  TransactionMeta,
  TransactionStage,
} from '../../types';
import { TransactionType } from '../../types';
import { getDelegationAddress as fetchDelegationAddress } from '../../utils/eip7702';
import { updateFirstTimeInteraction } from '../../utils/first-time-interaction';
import { updateSwapsTransaction } from '../../utils/swaps';
import { determineTransactionType } from '../../utils/transaction-type';
import { setEnvelopeType } from '../../utils/utils';
import { validateTxParams } from '../../utils/validation';

type Write = (mutate: (tx: TransactionMeta) => void) => void;

export const data: TransactionStage = async (
  transactionMeta,
  options,
  _callbacks,
  context,
) => {
  const { id: transactionId } = transactionMeta;

  const write: Write = (mutate) => {
    mutate(transactionMeta);

    context.updateTransactionInternal(
      {
        transactionId,
        skipResimulateCheck: true,
        skipValidation: true,
      },
      mutate,
    );
  };

  try {
    const isEIP1559Compatible = await getEnvelopeType(
      transactionMeta,
      context,
      write,
    );

    await Promise.all([
      getTransactionType(transactionMeta, context, write),
      getAfterAddHook(transactionMeta, context, write),
    ]);

    await getGasProperties(transactionMeta, options, context, write);
    getValidation(transactionMeta, isEIP1559Compatible);
    await getSecurityProvider(transactionMeta, options, context, write);
    getSwapsData(transactionMeta, options, context, write);
    markReady(transactionMeta, write);
    getDelegationAddress(transactionMeta, context, write).catch(
      () => undefined,
    );
    getSimulationAndFirstTimeInteraction(transactionMeta, options, context);
  } catch (error: unknown) {
    log('Error resolving transaction data', transactionId, error);
    const latestMeta = context.getTransaction(transactionId);
    if (latestMeta) {
      context.failTransaction(latestMeta, error as Error);
    }
  }
};

async function getEnvelopeType(
  transactionMeta: TransactionMeta,
  context: TransactionContext,
  write: Write,
): Promise<boolean> {
  const isEIP1559Compatible = await context.getEIP1559Compatibility(
    transactionMeta.networkClientId,
  );

  if (!transactionMeta.txParams.type) {
    write((tx) => {
      setEnvelopeType(tx.txParams, isEIP1559Compatible);
    });
  }

  return isEIP1559Compatible;
}

async function getTransactionType(
  transactionMeta: TransactionMeta,
  context: TransactionContext,
  write: Write,
): Promise<void> {
  if (transactionMeta.type !== undefined) {
    return;
  }

  const ethQuery = context.getEthQuery({
    networkClientId: transactionMeta.networkClientId,
  });

  const { type } = await determineTransactionType(
    transactionMeta.txParams,
    ethQuery,
  );

  write((tx) => {
    tx.type = type;
  });
}

async function getAfterAddHook(
  transactionMeta: TransactionMeta,
  context: TransactionContext,
  write: Write,
): Promise<void> {
  const { updateTransaction } = await context.afterAdd({
    transactionMeta,
  });

  if (updateTransaction) {
    write((tx) => {
      tx.txParamsOriginal = cloneDeep(tx.txParams);
    });

    updateTransaction(transactionMeta);
  }
}

async function getGasProperties(
  transactionMeta: TransactionMeta,
  options: AddTransactionOptions,
  context: TransactionContext,
  write: Write,
): Promise<void> {
  if (options.skipInitialGasEstimate) {
    getGasUpdateAsync(transactionMeta, context, options.traceContext).catch(
      () => undefined,
    );
    return;
  }

  await context.updateGasProperties(transactionMeta, {
    traceContext: options.traceContext,
  });

  write((tx) => {
    tx.txParams = { ...transactionMeta.txParams };
  });
}

function getValidation(
  transactionMeta: TransactionMeta,
  isEIP1559Compatible: boolean,
): void {
  validateTxParams(
    transactionMeta.txParams,
    isEIP1559Compatible,
    transactionMeta.chainId,
  );
}

async function getSecurityProvider(
  transactionMeta: TransactionMeta,
  options: AddTransactionOptions,
  context: TransactionContext,
  write: Write,
): Promise<void> {
  if (!options.method || !context.securityProviderRequest) {
    return;
  }

  const securityProviderResponse = await context.securityProviderRequest(
    transactionMeta,
    options.method,
  );

  write((tx) => {
    tx.securityProviderResponse = securityProviderResponse;
  });
}

function getSwapsData(
  transactionMeta: TransactionMeta,
  options: AddTransactionOptions,
  context: TransactionContext,
  write: Write,
): void {
  const enriched = updateSwapsTransaction(
    transactionMeta,
    transactionMeta.type ?? TransactionType.simpleSend,
    options.swaps ?? {},
    {
      isSwapsDisabled: context.isSwapsDisabled,
      cancelTransaction: context.cancelTransaction,
      messenger: context.messenger,
    },
  );

  write((tx) => {
    Object.assign(tx, enriched);
  });
}

function markReady(transactionMeta: TransactionMeta, write: Write): void {
  if (transactionMeta.ready !== false) {
    return;
  }

  write((tx) => {
    tx.ready = true;
  });
}

async function getDelegationAddress(
  transactionMeta: TransactionMeta,
  context: TransactionContext,
  write: Write,
): Promise<void> {
  const ethQuery = context.getEthQuery({
    networkClientId: transactionMeta.networkClientId,
  });

  const delegationAddress = await fetchDelegationAddress(
    transactionMeta.txParams.from as Hex,
    ethQuery,
  );

  write((tx) => {
    tx.delegationAddress = delegationAddress;
  });
}

async function getGasUpdateAsync(
  transactionMeta: TransactionMeta,
  context: TransactionContext,
  traceContext?: unknown,
): Promise<void> {
  const newTransactionMeta = cloneDeep(transactionMeta);

  await context.updateGasProperties(newTransactionMeta, { traceContext });

  context.updateTransactionInternal(
    {
      transactionId: newTransactionMeta.id,
      skipResimulateCheck: true,
      skipValidation: true,
    },
    (tx) => {
      tx.txParams.gas = newTransactionMeta.txParams.gas;
      tx.txParams.gasPrice = newTransactionMeta.txParams.gasPrice;
      tx.txParams.maxFeePerGas = newTransactionMeta.txParams.maxFeePerGas;
      tx.txParams.maxPriorityFeePerGas =
        newTransactionMeta.txParams.maxPriorityFeePerGas;
    },
  );
}

function getSimulationAndFirstTimeInteraction(
  transactionMeta: TransactionMeta,
  options: AddTransactionOptions,
  context: TransactionContext,
): void {
  if (options.requireApproval === false || options.isStateOnly) {
    log(
      'Skipping simulation & first interaction update as approval not required',
    );
    return;
  }

  const latestMeta =
    context.getTransaction(transactionMeta.id) ?? transactionMeta;

  updateSimulation(latestMeta, options, context).catch((error) => {
    log('Error while updating simulation data', error);
  });

  updateFirstTimeInteractionData(latestMeta, options, context).catch(
    (error) => {
      log('Error while updating first interaction properties', error);
    },
  );
}

async function updateSimulation(
  transactionMeta: TransactionMeta,
  options: AddTransactionOptions,
  context: TransactionContext,
): Promise<void> {
  await context.updateSimulationData(transactionMeta, {
    traceContext: options.traceContext,
  });
}

async function updateFirstTimeInteractionData(
  transactionMeta: TransactionMeta,
  options: AddTransactionOptions,
  context: TransactionContext,
): Promise<void> {
  await updateFirstTimeInteraction({
    existingTransactions: context.existingTransactions,
    getTransaction: context.getTransaction,
    isFirstTimeInteractionEnabled: context.isFirstTimeInteractionEnabled,
    trace: context.trace,
    traceContext: options.traceContext,
    transactionMeta,
    updateTransaction: context.updateTransactionInternal,
  });
}
