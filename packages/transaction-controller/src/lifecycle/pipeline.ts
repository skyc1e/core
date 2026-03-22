import { ORIGIN_METAMASK } from '@metamask/controller-utils';
import { JsonRpcError } from '@metamask/rpc-errors';
import { cloneDeep } from 'lodash';
import { v1 as random } from 'uuid';

import { data } from './stages/data';
import { projectLogger as log } from '../logger';
import type {
  AddTransactionOptions,
  DappSuggestedGasFees,
  PipelineCallbacks,
  StartTransactionResult,
  TransactionContext,
  TransactionMeta,
  TransactionParams,
} from '../types';
import { TransactionStatus } from '../types';
import { normalizeTransactionParams } from '../utils/utils';
import {
  ErrorCode,
  validateTransactionOrigin,
  validateTxParams,
} from '../utils/validation';

export function startTransaction(
  txParams: TransactionParams,
  options: AddTransactionOptions,
  context: TransactionContext,
): StartTransactionResult {
  const normalizedParams = normalizeTransactionParams(txParams);

  if (!context.hasNetworkClient(options.networkClientId)) {
    throw new Error(`Network client not found - ${options.networkClientId}`);
  }

  if (options.origin !== undefined && options.origin !== ORIGIN_METAMASK) {
    throw new Error(
      'The instant option is not supported for external transactions.',
    );
  }

  const dappSuggestedGasFees = context.generateDappSuggestedGasFees(
    normalizedParams,
    options.origin,
  );

  const transactionMeta = buildTransactionMeta(
    normalizedParams,
    options,
    context,
    dappSuggestedGasFees,
    { ready: false },
  );

  context.addMetadata(transactionMeta);
  context.publishEvent(transactionMeta);

  const result = runPipeline(transactionMeta, options, context);

  return { transactionMeta, result };
}

async function runPipeline(
  transactionMeta: TransactionMeta,
  options: AddTransactionOptions,
  context: TransactionContext,
): Promise<string> {
  const callbacks: PipelineCallbacks = { onSuccess: [], onError: [] };

  try {
    await data(cloneDeep(transactionMeta), options, callbacks, context);

    return await processApprovalWithCallbacks(
      transactionMeta,
      options,
      context,
      callbacks,
    );
  } catch (error) {
    for (const fn of callbacks.onError) {
      fn(error as Error);
    }

    throw error;
  }
}

async function processApprovalWithCallbacks(
  transactionMeta: TransactionMeta,
  options: AddTransactionOptions,
  context: TransactionContext,
  callbacks: PipelineCallbacks,
): Promise<string> {
  try {
    const hash = await context.processApproval(transactionMeta, {
      actionId: options.actionId,
      isExisting: false,
      publishHook: options.publishHook,
      requireApproval: options.requireApproval,
      traceContext: options.traceContext,
    });

    for (const fn of callbacks.onSuccess) {
      fn();
    }

    return hash;
  } catch (error) {
    for (const fn of callbacks.onError) {
      fn(error as Error);
    }

    throw error;
  }
}

export async function addTransaction(
  txParams: TransactionParams,
  options: AddTransactionOptions,
  context: TransactionContext,
): Promise<{ transactionMeta: TransactionMeta; result: Promise<string> }> {
  log('Adding transaction', txParams, options);

  const normalizedParams = normalizeTransactionParams(txParams);

  if (!context.hasNetworkClient(options.networkClientId)) {
    throw new Error(`Network client not found - ${options.networkClientId}`);
  }

  if (
    options.instant &&
    options.origin !== undefined &&
    options.origin !== ORIGIN_METAMASK
  ) {
    throw new Error(
      'The instant option is not supported for external transactions.',
    );
  }

  if (options.origin !== undefined && options.origin !== ORIGIN_METAMASK) {
    const permittedAddresses = await context.getPermittedAccounts?.(
      options.origin,
    );

    const internalAccounts = context.getInternalAccounts();

    await validateTransactionOrigin({
      data: normalizedParams.data,
      from: normalizedParams.from,
      internalAccounts,
      origin: options.origin,
      permittedAddresses,
      txParams: normalizedParams,
      type: options.type,
    });
  }

  const { batchId } = options;

  if (
    batchId?.length &&
    context.existingTransactions.some(
      (tx) => tx.batchId?.toLowerCase() === batchId?.toLowerCase(),
    )
  ) {
    if (options.origin && options.origin !== ORIGIN_METAMASK) {
      throw new JsonRpcError(
        ErrorCode.DuplicateBundleId,
        'Batch ID already exists',
      );
    }
  }

  const existingTransactionMeta = context.getTransactionWithActionId(
    options.actionId,
  );

  if (existingTransactionMeta) {
    const transactionMeta = cloneDeep(existingTransactionMeta);

    return {
      transactionMeta,
      result: context.processApproval(transactionMeta, {
        actionId: options.actionId,
        isExisting: true,
        publishHook: options.publishHook,
        requireApproval: options.requireApproval,
        traceContext: options.traceContext,
      }),
    };
  }

  const dappSuggestedGasFees = context.generateDappSuggestedGasFees(
    normalizedParams,
    options.origin,
  );

  const transactionMeta = buildTransactionMeta(
    normalizedParams,
    options,
    context,
    dappSuggestedGasFees,
    { ready: options.instant ? false : undefined },
  );

  context.addMetadata(transactionMeta);
  context.publishEvent(transactionMeta);

  if (options.instant) {
    return {
      transactionMeta,
      result: runPipeline(transactionMeta, options, context),
    };
  }

  const callbacks: PipelineCallbacks = { onSuccess: [], onError: [] };

  await data(cloneDeep(transactionMeta), options, callbacks, context);

  const resolvedMeta =
    context.getTransaction(transactionMeta.id) ?? transactionMeta;

  return {
    transactionMeta: resolvedMeta,
    result: processApprovalWithCallbacks(
      resolvedMeta,
      options,
      context,
      callbacks,
    ),
  };
}

function buildTransactionMeta(
  txParams: TransactionParams,
  options: AddTransactionOptions,
  context: TransactionContext,
  dappSuggestedGasFees: DappSuggestedGasFees | undefined,
  { ready }: { ready?: boolean } = {},
): TransactionMeta {
  validateTxParams(txParams);

  return {
    actionId: options.actionId,
    assetsFiatValues: options.assetsFiatValues,
    batchId: options.batchId,
    chainId: context.getChainId(options.networkClientId),
    dappSuggestedGasFees,
    deviceConfirmedOn: options.deviceConfirmedOn,
    disableGasBuffer: options.disableGasBuffer,
    id: random(),
    isGasFeeTokenIgnoredIfBalance: Boolean(options.gasFeeToken),
    isGasFeeIncluded: options.isGasFeeIncluded,
    isGasFeeSponsored: options.isGasFeeSponsored,
    isStateOnly: options.isStateOnly,
    nestedTransactions: options.nestedTransactions,
    networkClientId: options.networkClientId,
    origin: options.origin,
    ready,
    requestId: options.requestId,
    requiredAssets: options.requiredAssets,
    securityAlertResponse: options.securityAlertResponse,
    selectedGasFeeToken: options.gasFeeToken,
    status: TransactionStatus.unapproved as const,
    time: Date.now(),
    txParams,
    type: options.type,
    userEditedGasLimit: false,
    verifiedOnBlockchain: false,
  };
}
