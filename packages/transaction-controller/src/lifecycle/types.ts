import type { TraceCallback } from '@metamask/controller-utils';
import type EthQuery from '@metamask/eth-query';
import type { Hex } from '@metamask/utils';

import type { TransactionControllerMessenger } from '../TransactionController';
import type {
  AddTransactionOptions,
  DappSuggestedGasFees,
  PublishHook,
  SecurityProviderRequest,
  TransactionMeta,
  TransactionParams,
} from '../types';

export type PipelineCallbacks = {
  onSuccess: (() => void)[];
  onError: ((error: Error) => void)[];
};

export type TransactionContext = {
  addMetadata: (transactionMeta: TransactionMeta) => void;

  afterAdd: (opts: {
    transactionMeta: TransactionMeta;
  }) => Promise<{ updateTransaction?: (tx: TransactionMeta) => void }>;

  cancelTransaction: (id: string) => void;
  existingTransactions: TransactionMeta[];

  failTransaction: (transactionMeta: TransactionMeta, error: Error) => void;

  generateDappSuggestedGasFees: (
    txParams: TransactionParams,
    origin?: string,
  ) => DappSuggestedGasFees | undefined;

  getChainId: (networkClientId: string) => Hex;
  getEIP1559Compatibility: (networkClientId: string) => Promise<boolean>;
  getEthQuery: (opts: { networkClientId: string }) => EthQuery;
  getInternalAccounts: () => Hex[];
  getPermittedAccounts?: (origin?: string) => Promise<string[]>;
  getTransaction: (id: string) => TransactionMeta | undefined;

  getTransactionWithActionId: (
    actionId?: string,
  ) => TransactionMeta | undefined;

  hasNetworkClient: (networkClientId: string) => boolean;
  isFirstTimeInteractionEnabled: () => boolean;
  isSwapsDisabled: boolean;
  messenger: TransactionControllerMessenger;

  processApproval: (
    transactionMeta: TransactionMeta,
    opts: {
      actionId?: string;
      isExisting?: boolean;
      publishHook?: PublishHook;
      requireApproval?: boolean;
      shouldShowRequest?: boolean;
      traceContext?: unknown;
    },
  ) => Promise<string>;

  publishEvent: (transactionMeta: TransactionMeta) => void;

  requestApproval: (
    transactionMeta: TransactionMeta,
    opts: { shouldShowRequest: boolean; traceContext?: unknown },
  ) => Promise<unknown>;

  securityProviderRequest?: SecurityProviderRequest;
  trace: TraceCallback;

  updateGasProperties: (
    transactionMeta: TransactionMeta,
    opts?: { traceContext?: unknown },
  ) => Promise<void>;

  updateSimulationData: (
    transactionMeta: TransactionMeta,
    opts: { traceContext?: unknown },
  ) => Promise<void>;

  updateTransactionInternal: (
    opts: {
      transactionId: string;
      note?: string;
      skipResimulateCheck?: boolean;
      skipValidation?: boolean;
    },
    mutate: (tx: TransactionMeta) => void,
  ) => void;
};

export type TransactionStage = (
  transactionMeta: TransactionMeta,
  options: AddTransactionOptions,
  callbacks: PipelineCallbacks,
  context: TransactionContext,
) => Promise<void>;

export type StartTransactionResult = {
  transactionMeta: TransactionMeta;
  result: Promise<string>;
};
