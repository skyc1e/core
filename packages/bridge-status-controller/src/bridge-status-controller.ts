import type { StateMetadata } from '@metamask/base-controller';
import type {
  QuoteMetadata,
  RequiredEventContextFromClient,
  QuoteResponse,
  Trade,
} from '@metamask/bridge-controller';
import {
  isNonEvmChainId,
  StatusTypes,
  UnifiedSwapBridgeEventName,
  isCrossChain,
  isHardwareWallet,
  MetricsActionType,
  MetaMetricsSwapsEventSource,
  PollingStatus,
  formatChainIdToHex,
} from '@metamask/bridge-controller';
import type { TraceCallback } from '@metamask/controller-utils';
import { StaticIntervalPollingController } from '@metamask/polling-controller';
import {
  TransactionStatus,
  TransactionType,
  TransactionController,
} from '@metamask/transaction-controller';
import type { TransactionMeta } from '@metamask/transaction-controller';
import { numberToHex } from '@metamask/utils';
import type { Hex } from '@metamask/utils';

import { IntentManager } from './bridge-status-controller.intent';
import {
  BRIDGE_PROD_API_BASE_URL,
  BRIDGE_STATUS_CONTROLLER_NAME,
  DEFAULT_BRIDGE_STATUS_CONTROLLER_STATE,
  MAX_ATTEMPTS,
  REFRESH_INTERVAL_MS,
} from './constants';
import executeSubmitFlow from './strategy';
import type { SubmitStrategyParams } from './strategy/types';
import type {
  BridgeStatusControllerState,
  StartPollingForBridgeTxStatusArgsSerialized,
  FetchFunction,
  SolanaTransactionMeta,
  BridgeHistoryItem,
} from './types';
import type { BridgeStatusControllerMessenger } from './types';
import { BridgeClientId } from './types';
import { getAccountByAddress } from './utils/accounts';
import { getJwt } from './utils/authentication';
import { stopPollingForQuotes, trackMetricsEvent } from './utils/bridge';
import {
  fetchBridgeTxStatus,
  getStatusRequestWithSrcTxHash,
  shouldSkipFetchDueToFetchFailures,
} from './utils/bridge-status';
import {
  getInitialHistoryItem,
  rekeyHistoryItemInState,
  shouldPollHistoryItem,
} from './utils/history';
import {
  getFinalizedTxProperties,
  getPriceImpactFromQuote,
  getRequestMetadataFromHistory,
  getRequestParamFromHistory,
  getTradeDataFromHistory,
  getEVMTxPropertiesFromTransactionMeta,
  getTxStatusesFromHistory,
  getPreConfirmationPropertiesFromQuote,
} from './utils/metrics';
import { getSelectedChainId } from './utils/network';
import { getTraceParams } from './utils/trace';
import {
  getTransactionMetaById,
  getTransactions,
  checkIsDelegatedAccount,
} from './utils/transaction';

const metadata: StateMetadata<BridgeStatusControllerState> = {
  // We want to persist the bridge status state so that we can show the proper data for the Activity list
  // basically match the behavior of TransactionController
  txHistory: {
    includeInStateLogs: true,
    persist: true,
    includeInDebugSnapshot: false,
    usedInUi: true,
  },
};

/** The input to start polling for the {@link BridgeStatusController} */
type BridgeStatusPollingInput = FetchBridgeTxStatusArgs;

type SrcTxMetaId = string;
export type FetchBridgeTxStatusArgs = {
  bridgeTxMetaId: string;
};
export class BridgeStatusController extends StaticIntervalPollingController<BridgeStatusPollingInput>()<
  typeof BRIDGE_STATUS_CONTROLLER_NAME,
  BridgeStatusControllerState,
  BridgeStatusControllerMessenger
> {
  #pollingTokensByTxMetaId: Record<SrcTxMetaId, string> = {};

  readonly #intentManager: IntentManager;

  readonly #clientId: BridgeClientId;

  readonly #fetchFn: FetchFunction;

  readonly #config: {
    customBridgeApiBaseUrl: string;
  };

  readonly #addTransactionBatchFn: typeof TransactionController.prototype.addTransactionBatch;

  readonly #trace: TraceCallback;

  constructor({
    messenger,
    state,
    clientId,
    fetchFn,
    addTransactionBatchFn,
    config,
    traceFn,
  }: {
    messenger: BridgeStatusControllerMessenger;
    state?: Partial<BridgeStatusControllerState>;
    clientId: BridgeClientId;
    fetchFn: FetchFunction;
    addTransactionBatchFn: typeof TransactionController.prototype.addTransactionBatch;
    config?: {
      customBridgeApiBaseUrl?: string;
    };
    traceFn?: TraceCallback;
  }) {
    super({
      name: BRIDGE_STATUS_CONTROLLER_NAME,
      metadata,
      messenger,
      // Restore the persisted state
      state: {
        ...DEFAULT_BRIDGE_STATUS_CONTROLLER_STATE,
        ...state,
      },
    });

    this.#clientId = clientId;
    this.#fetchFn = fetchFn;
    this.#addTransactionBatchFn = addTransactionBatchFn;
    this.#config = {
      customBridgeApiBaseUrl:
        config?.customBridgeApiBaseUrl ?? BRIDGE_PROD_API_BASE_URL,
    };
    this.#trace = traceFn ?? (((_request, fn) => fn?.()) as TraceCallback);
    this.#intentManager = new IntentManager({
      messenger: this.messenger,
      customBridgeApiBaseUrl: this.#config.customBridgeApiBaseUrl,
      fetchFn: this.#fetchFn,
    });

    // Register action handlers
    this.messenger.registerActionHandler(
      `${BRIDGE_STATUS_CONTROLLER_NAME}:startPollingForBridgeTxStatus`,
      this.startPollingForBridgeTxStatus.bind(this),
    );
    this.messenger.registerActionHandler(
      `${BRIDGE_STATUS_CONTROLLER_NAME}:wipeBridgeStatus`,
      this.wipeBridgeStatus.bind(this),
    );
    this.messenger.registerActionHandler(
      `${BRIDGE_STATUS_CONTROLLER_NAME}:resetState`,
      this.resetState.bind(this),
    );
    this.messenger.registerActionHandler(
      `${BRIDGE_STATUS_CONTROLLER_NAME}:submitTx`,
      this.submitTx.bind(this),
    );
    this.messenger.registerActionHandler(
      `${BRIDGE_STATUS_CONTROLLER_NAME}:submitIntent`,
      this.submitIntent.bind(this),
    );
    this.messenger.registerActionHandler(
      `${BRIDGE_STATUS_CONTROLLER_NAME}:restartPollingForFailedAttempts`,
      this.restartPollingForFailedAttempts.bind(this),
    );
    this.messenger.registerActionHandler(
      `${BRIDGE_STATUS_CONTROLLER_NAME}:getBridgeHistoryItemByTxMetaId`,
      this.getBridgeHistoryItemByTxMetaId.bind(this),
    );

    // Set interval
    this.setIntervalLength(REFRESH_INTERVAL_MS);

    this.messenger.subscribe(
      'TransactionController:transactionFailed',
      ({ transactionMeta }) => {
        const { type, status, id: txMetaId, actionId } = transactionMeta;

        if (
          type &&
          [
            TransactionType.bridge,
            TransactionType.swap,
            TransactionType.bridgeApproval,
            TransactionType.swapApproval,
          ].includes(type) &&
          [
            TransactionStatus.failed,
            TransactionStatus.dropped,
            TransactionStatus.rejected,
          ].includes(status)
        ) {
          // Mark tx as failed in txHistory
          this.#markTxAsFailed(transactionMeta);
          // Track failed event
          if (status !== TransactionStatus.rejected) {
            // Look up history by txMetaId first, then by actionId (for pre-submission failures)
            let historyKey: string | undefined;
            if (this.state.txHistory[txMetaId]) {
              historyKey = txMetaId;
            } else if (actionId && this.state.txHistory[actionId]) {
              historyKey = actionId;
            }

            this.#trackUnifiedSwapBridgeEvent(
              UnifiedSwapBridgeEventName.Failed,
              historyKey ?? txMetaId,
              getEVMTxPropertiesFromTransactionMeta(transactionMeta),
            );
          }
        }
      },
    );

    this.messenger.subscribe(
      'TransactionController:transactionConfirmed',
      (transactionMeta) => {
        const { type, id: txMetaId, chainId } = transactionMeta;
        if (type === TransactionType.swap) {
          this.#trackUnifiedSwapBridgeEvent(
            UnifiedSwapBridgeEventName.Completed,
            txMetaId,
          );
        }
        if (type === TransactionType.bridge && !isNonEvmChainId(chainId)) {
          this.#startPollingForTxId(txMetaId);
        }
      },
    );

    // If you close the extension, but keep the browser open, the polling continues
    // If you close the browser, the polling stops
    // Check for historyItems that do not have a status of complete and restart polling
    this.#restartPollingForIncompleteHistoryItems();
  }

  // Mark tx as failed in txHistory if either the approval or trade fails
  readonly #markTxAsFailed = ({
    id: txMetaId,
    actionId,
  }: TransactionMeta): void => {
    // Look up by txMetaId first
    let txHistoryKey: string | undefined = this.state.txHistory[txMetaId]
      ? txMetaId
      : undefined;

    // If not found by txMetaId, try looking up by actionId (for pre-submission failures)
    if (!txHistoryKey && actionId && this.state.txHistory[actionId]) {
      txHistoryKey = actionId;
    }

    // If still not found, try looking up by approvalTxId
    txHistoryKey ??= Object.keys(this.state.txHistory).find(
      (key) => this.state.txHistory[key].approvalTxId === txMetaId,
    );

    if (!txHistoryKey) {
      return;
    }
    const key = txHistoryKey;
    this.update((statusState) => {
      statusState.txHistory[key].status.status = StatusTypes.FAILED;
    });
  };

  resetState = (): void => {
    this.update((state) => {
      state.txHistory = DEFAULT_BRIDGE_STATUS_CONTROLLER_STATE.txHistory;
    });
  };

  wipeBridgeStatus = ({
    address,
    ignoreNetwork,
  }: {
    address: string;
    ignoreNetwork: boolean;
  }): void => {
    // Wipe all networks for this address
    if (ignoreNetwork) {
      this.update((state) => {
        state.txHistory = DEFAULT_BRIDGE_STATUS_CONTROLLER_STATE.txHistory;
      });
    } else {
      const selectedChainId = getSelectedChainId(this.messenger);

      this.#wipeBridgeStatusByChainId(address, selectedChainId);
    }
  };

  /**
   * Resets the attempts counter for a bridge transaction history item
   * and restarts polling if it was previously stopped due to max attempts
   *
   * @param identifier - Object containing either txMetaId or txHash to identify the history item
   * @param identifier.txMetaId - The transaction meta ID
   * @param identifier.txHash - The transaction hash
   */
  restartPollingForFailedAttempts = (identifier: {
    txMetaId?: string;
    txHash?: string;
  }): void => {
    const { txMetaId, txHash } = identifier;

    if (!txMetaId && !txHash) {
      throw new Error('Either txMetaId or txHash must be provided');
    }

    // Find the history item by txMetaId or txHash
    let targetTxMetaId: string | undefined;

    if (txMetaId) {
      // Direct lookup by txMetaId
      if (this.state.txHistory[txMetaId]) {
        targetTxMetaId = txMetaId;
      }
    } else if (txHash) {
      // Search by txHash in status.srcChain.txHash
      targetTxMetaId = Object.keys(this.state.txHistory).find(
        (id) => this.state.txHistory[id].status.srcChain.txHash === txHash,
      );
    }

    if (!targetTxMetaId) {
      throw new Error(
        `No bridge transaction history found for ${
          txMetaId ? `txMetaId: ${txMetaId}` : `txHash: ${txHash}`
        }`,
      );
    }

    const historyItem = this.state.txHistory[targetTxMetaId];

    // Capture attempts count before resetting for metrics
    const previousAttempts = historyItem.attempts?.counter ?? 0;

    // Reset the attempts counter
    this.update((state) => {
      if (targetTxMetaId) {
        state.txHistory[targetTxMetaId].attempts = undefined;
      }
    });

    // Restart polling if it was stopped and this tx still needs status updates
    if (shouldPollHistoryItem(historyItem)) {
      // Check if polling was stopped (no active polling token)
      const existingPollingToken =
        this.#pollingTokensByTxMetaId[targetTxMetaId];

      if (!existingPollingToken) {
        // Restart polling
        this.#startPollingForTxId(targetTxMetaId);

        // Track polling manually restarted event
        if (!historyItem.featureId) {
          const selectedAccount = getAccountByAddress(
            this.messenger,
            historyItem.account,
          );
          const requestParams = getRequestParamFromHistory(historyItem);
          const requestMetadata = getRequestMetadataFromHistory(
            historyItem,
            selectedAccount,
          );
          const { security_warnings: _, ...metadataWithoutWarnings } =
            requestMetadata;

          this.#trackUnifiedSwapBridgeEvent(
            UnifiedSwapBridgeEventName.PollingStatusUpdated,
            targetTxMetaId,
            {
              ...getTradeDataFromHistory(historyItem),
              ...getPriceImpactFromQuote(historyItem.quote),
              ...metadataWithoutWarnings,
              chain_id_source: requestParams.chain_id_source,
              chain_id_destination: requestParams.chain_id_destination,
              token_symbol_source: requestParams.token_symbol_source,
              token_symbol_destination: requestParams.token_symbol_destination,
              action_type: MetricsActionType.SWAPBRIDGE_V1,
              polling_status: PollingStatus.ManuallyRestarted,
              retry_attempts: previousAttempts,
            },
          );
        }
      }
    }
  };

  /**
   * Gets a bridge history item from the history by its transaction meta ID
   *
   * @param txMetaId - The transaction meta ID to look up
   * @returns The bridge history item if found, undefined otherwise
   */
  getBridgeHistoryItemByTxMetaId = (
    txMetaId: string,
  ): BridgeHistoryItem | undefined => {
    return this.state.txHistory[txMetaId];
  };

  /**
   * Restart polling for txs that are not in a final state
   * This is called during initialization
   */
  readonly #restartPollingForIncompleteHistoryItems = (): void => {
    // Check for historyItems that do not have a status of complete and restart polling
    const { txHistory } = this.state;
    const historyItems = Object.values(txHistory);
    const incompleteHistoryItems = historyItems
      .filter(
        (historyItem) =>
          historyItem.status.status === StatusTypes.PENDING ||
          historyItem.status.status === StatusTypes.UNKNOWN,
      )
      // Only poll items with txMetaId (post-submission items)
      .filter(
        (
          historyItem,
        ): historyItem is BridgeHistoryItem & { txMetaId: string } =>
          Boolean(historyItem.txMetaId),
      )
      .filter((historyItem) => {
        // Check if we are already polling this tx, if so, skip restarting polling for that
        const pollingToken =
          this.#pollingTokensByTxMetaId[historyItem.txMetaId];
        return !pollingToken;
      })
      // Only restart polling for items that still require status updates
      .filter((historyItem) => {
        return shouldPollHistoryItem(historyItem);
      });

    incompleteHistoryItems.forEach((historyItem) => {
      const bridgeTxMetaId = historyItem.txMetaId;
      const shouldSkipFetch = shouldSkipFetchDueToFetchFailures(
        historyItem.attempts,
      );
      if (shouldSkipFetch) {
        return;
      }

      // We manually call startPolling() here rather than go through startPollingForBridgeTxStatus()
      // because we don't want to overwrite the existing historyItem in state
      this.#startPollingForTxId(bridgeTxMetaId);
    });
  };

  readonly #addTxToHistory = (
    ...args: Parameters<typeof getInitialHistoryItem>
  ): void => {
    // Use actionId as key for pre-submission, or txMeta.id for post-submission
    const { historyKey, txHistoryItem } = getInitialHistoryItem(...args);
    this.update((state) => {
      state.txHistory[historyKey] = txHistoryItem;
    });
  };

  /**
   * Rekeys a history item from actionId to txMeta.id after successful submission.
   * Also updates txMetaId and srcTxHash which weren't available pre-submission.
   *
   * @param actionId - The actionId used as the temporary key for the history item
   * @param txMeta - The transaction meta from the successful submission
   * @param txMeta.id - The transaction meta id to use as the new key
   * @param txMeta.hash - The transaction hash to set on the history item
   */
  readonly #rekeyHistoryItem = (
    actionId: string,
    txMeta: { id: string; hash?: string },
  ): void => {
    this.update((state) => {
      rekeyHistoryItemInState(state, actionId, txMeta);
    });
  };

  readonly #startPollingForTxId = (txId: string): void => {
    // If we are already polling for this tx, stop polling for it before restarting
    const existingPollingToken = this.#pollingTokensByTxMetaId[txId];
    if (existingPollingToken) {
      this.stopPollingByPollingToken(existingPollingToken);
    }

    const txHistoryItem = this.state.txHistory[txId];
    if (!txHistoryItem) {
      return;
    }
    if (shouldPollHistoryItem(txHistoryItem)) {
      this.#pollingTokensByTxMetaId[txId] = this.startPolling({
        bridgeTxMetaId: txId,
      });
    }
  };

  /**
   * @deprecated For EVM/Solana swap/bridge txs we add tx to history in submitTx()
   * For Solana swap/bridge we start polling in submitTx()
   * For EVM bridge we listen for 'TransactionController:transactionConfirmed' and start polling there
   * No clients currently call this, safe to remove in future versions
   *
   * Adds tx to history and starts polling for the bridge tx status
   *
   * @param txHistoryMeta - The parameters for creating the history item
   */
  startPollingForBridgeTxStatus = (
    txHistoryMeta: StartPollingForBridgeTxStatusArgsSerialized,
  ): void => {
    const { bridgeTxMeta } = txHistoryMeta;

    if (!bridgeTxMeta?.id) {
      throw new Error(
        'Cannot start polling: bridgeTxMeta.id is required for polling',
      );
    }

    this.#addTxToHistory(txHistoryMeta);
    this.#startPollingForTxId(bridgeTxMeta.id);
  };

  // This will be called after you call this.startPolling()
  // The args passed in are the args you passed in to startPolling()
  _executePoll = async (
    pollingInput: BridgeStatusPollingInput,
  ): Promise<void> => {
    await this.#fetchBridgeTxStatus(pollingInput);
  };

  /**
   * Handles the failure to fetch the bridge tx status
   * We eventually stop polling for the tx if we fail too many times
   * Failures (500 errors) can be due to:
   * - The srcTxHash not being available immediately for STX
   * - The srcTxHash being invalid for the chain. This case will never resolve so we stop polling for it to avoid hammering the Bridge API forever.
   *
   * @param bridgeTxMetaId - The txMetaId of the bridge tx
   */
  readonly #handleFetchFailure = (bridgeTxMetaId: string): void => {
    const { attempts } = this.state.txHistory[bridgeTxMetaId];

    const newAttempts = attempts
      ? {
          counter: attempts.counter + 1,
          lastAttemptTime: Date.now(),
        }
      : {
          counter: 1,
          lastAttemptTime: Date.now(),
        };

    // If we've failed too many times, stop polling for the tx
    const pollingToken = this.#pollingTokensByTxMetaId[bridgeTxMetaId];
    if (newAttempts.counter >= MAX_ATTEMPTS && pollingToken) {
      this.stopPollingByPollingToken(pollingToken);
      delete this.#pollingTokensByTxMetaId[bridgeTxMetaId];

      // Track max polling reached event
      const historyItem = this.state.txHistory[bridgeTxMetaId];
      if (historyItem && !historyItem.featureId) {
        const selectedAccount = getAccountByAddress(
          this.messenger,
          historyItem.account,
        );
        const requestParams = getRequestParamFromHistory(historyItem);
        const requestMetadata = getRequestMetadataFromHistory(
          historyItem,
          selectedAccount,
        );
        const { security_warnings: _, ...metadataWithoutWarnings } =
          requestMetadata;

        this.#trackUnifiedSwapBridgeEvent(
          UnifiedSwapBridgeEventName.PollingStatusUpdated,
          bridgeTxMetaId,
          {
            ...getTradeDataFromHistory(historyItem),
            ...getPriceImpactFromQuote(historyItem.quote),
            ...metadataWithoutWarnings,
            chain_id_source: requestParams.chain_id_source,
            chain_id_destination: requestParams.chain_id_destination,
            token_symbol_source: requestParams.token_symbol_source,
            token_symbol_destination: requestParams.token_symbol_destination,
            action_type: MetricsActionType.SWAPBRIDGE_V1,
            polling_status: PollingStatus.MaxPollingReached,
            retry_attempts: newAttempts.counter,
          },
        );
      }
    }

    // Update the attempts counter
    this.update((state) => {
      state.txHistory[bridgeTxMetaId].attempts = newAttempts;
    });
  };

  readonly #fetchBridgeTxStatus = async ({
    bridgeTxMetaId,
  }: FetchBridgeTxStatusArgs): Promise<void> => {
    // 1. Check for history item

    const { txHistory } = this.state;
    const historyItem = txHistory[bridgeTxMetaId];
    if (!historyItem) {
      return;
    }

    // 2. Check for previous failures

    if (shouldSkipFetchDueToFetchFailures(historyItem.attempts)) {
      return;
    }

    // 3. Fetch transcation status

    try {
      let status: BridgeHistoryItem['status'];
      let validationFailures: string[] = [];

      if (historyItem.quote.intent) {
        const intentTxStatus =
          await this.#intentManager.getIntentTransactionStatus(
            bridgeTxMetaId,
            historyItem.quote.srcChainId,
            historyItem.quote.intent.protocol,
            this.#clientId,
            historyItem.status.srcChain.txHash,
          );

        if (
          intentTxStatus?.bridgeStatus === null ||
          intentTxStatus?.bridgeStatus === undefined
        ) {
          return;
        }
        status = intentTxStatus.bridgeStatus.status;
      } else {
        // We try here because we receive 500 errors from Bridge API if we try to fetch immediately after submitting the source tx
        // Oddly mostly happens on Optimism, never on Arbitrum. By the 2nd fetch, the Bridge API responds properly.
        // Also srcTxHash may not be available immediately for STX, so we don't want to fetch in those cases
        const srcTxHash = this.#getSrcTxHash(bridgeTxMetaId);
        if (!srcTxHash) {
          return;
        }

        this.#updateSrcTxHash(bridgeTxMetaId, srcTxHash);

        const statusRequest = getStatusRequestWithSrcTxHash(
          historyItem.quote,
          srcTxHash,
        );
        const response = await fetchBridgeTxStatus(
          statusRequest,
          this.#clientId,
          await getJwt(this.messenger),
          this.#fetchFn,
          this.#config.customBridgeApiBaseUrl,
        );
        status = response.status;
        validationFailures = response.validationFailures;
      }

      if (validationFailures.length > 0) {
        this.#trackUnifiedSwapBridgeEvent(
          UnifiedSwapBridgeEventName.StatusValidationFailed,
          bridgeTxMetaId,
          {
            failures: validationFailures,
            refresh_count: historyItem.attempts?.counter ?? 0,
          },
        );
        throw new Error(
          `Bridge status validation failed: ${validationFailures.join(', ')}`,
        );
      }

      // 4. Create bridge history item

      const newBridgeHistoryItem = {
        ...historyItem,
        status,
        completionTime:
          status.status === StatusTypes.COMPLETE ||
          status.status === StatusTypes.FAILED
            ? Date.now()
            : undefined, // TODO make this more accurate by looking up dest txHash block time
        attempts: undefined,
      };

      // No need to purge these on network change or account change, TransactionController does not purge either.
      // TODO In theory we can skip checking status if it's not the current account/network
      // we need to keep track of the account that this is associated with as well so that we don't show it in Activity list for other accounts
      // First stab at this will not stop polling when you are on a different account
      this.update((state) => {
        state.txHistory[bridgeTxMetaId] = newBridgeHistoryItem;
      });

      if (historyItem.quote.intent) {
        this.#intentManager.syncTransactionFromIntentStatus(
          bridgeTxMetaId,
          historyItem,
        );
      }

      // 5. After effects

      const pollingToken = this.#pollingTokensByTxMetaId[bridgeTxMetaId];

      const isFinalStatus =
        status.status === StatusTypes.COMPLETE ||
        status.status === StatusTypes.FAILED;

      if (isFinalStatus && pollingToken) {
        this.stopPollingByPollingToken(pollingToken);
        delete this.#pollingTokensByTxMetaId[bridgeTxMetaId];

        // Skip tracking events when featureId is set (i.e. PERPS)
        if (historyItem.featureId) {
          return;
        }

        if (status.status === StatusTypes.COMPLETE) {
          this.#trackUnifiedSwapBridgeEvent(
            UnifiedSwapBridgeEventName.Completed,
            bridgeTxMetaId,
          );
          this.messenger.publish(
            'BridgeStatusController:destinationTransactionCompleted',
            historyItem.quote.destAsset.assetId,
          );
        }
        if (status.status === StatusTypes.FAILED) {
          this.#trackUnifiedSwapBridgeEvent(
            UnifiedSwapBridgeEventName.Failed,
            bridgeTxMetaId,
          );
        }
      }
    } catch (error) {
      console.warn('Failed to fetch bridge tx status', error);
      this.#handleFetchFailure(bridgeTxMetaId);
    }
  };

  readonly #getSrcTxHash = (bridgeTxMetaId: string): string | undefined => {
    const { txHistory } = this.state;
    // Prefer the srcTxHash from bridgeStatusState so we don't have to l ook up in TransactionController
    // But it is possible to have bridgeHistoryItem in state without the srcTxHash yet when it is an STX
    const srcTxHash = txHistory[bridgeTxMetaId].status.srcChain.txHash;

    if (srcTxHash) {
      return srcTxHash;
    }

    // Look up in TransactionController if txMeta has been updated with the srcTxHash
    const txMeta = getTransactionMetaById(this.messenger, bridgeTxMetaId);
    return txMeta?.hash;
  };

  readonly #updateSrcTxHash = (
    bridgeTxMetaId: string,
    srcTxHash: string,
  ): void => {
    const { txHistory } = this.state;
    if (txHistory[bridgeTxMetaId].status.srcChain.txHash) {
      return;
    }

    this.update((state) => {
      state.txHistory[bridgeTxMetaId].status.srcChain.txHash = srcTxHash;
    });
  };

  // Wipes the bridge status for the given address and chainId
  // Will match only source chainId to the selectedChainId
  readonly #wipeBridgeStatusByChainId = (
    address: string,
    selectedChainId: Hex,
  ): void => {
    const sourceTxMetaIdsToDelete = Object.keys(this.state.txHistory).filter(
      (txMetaId) => {
        const bridgeHistoryItem = this.state.txHistory[txMetaId];

        const hexSourceChainId = numberToHex(
          bridgeHistoryItem.quote.srcChainId,
        );

        return (
          bridgeHistoryItem.account === address &&
          hexSourceChainId === selectedChainId
        );
      },
    );

    sourceTxMetaIdsToDelete.forEach((sourceTxMetaId) => {
      const pollingToken = this.#pollingTokensByTxMetaId[sourceTxMetaId];

      if (pollingToken) {
        this.stopPollingByPollingToken(
          this.#pollingTokensByTxMetaId[sourceTxMetaId],
        );
      }
    });

    this.update((state) => {
      state.txHistory = sourceTxMetaIdsToDelete.reduce(
        (acc, sourceTxMetaId) => {
          delete acc[sourceTxMetaId];
          return acc;
        },
        state.txHistory,
      );
    });
  };

  /**
   * ******************************************************
   * TX SUBMISSION HANDLING
   *******************************************************
   */

  /**
   * Submits a cross-chain swap transaction
   *
   * @param accountAddress - The address of the account to submit the transaction for
   * @param quoteResponse - The quote response
   * @param isStxEnabledOnClient - Whether smart transactions are enabled on the client, for example the getSmartTransactionsEnabled selector value from the extension
   * @param quotesReceivedContext - The context for the QuotesReceived event
   * @param location - The entry point from which the user initiated the swap or bridge (e.g. Main View, Token View, Trending Explore)
   * @param abTests - Legacy A/B test context for `ab_tests` (backward compatibility)
   * @param activeAbTests - New A/B test context for `active_ab_tests` (migration target). Attributes events to specific experiments.
   * @returns The transaction meta
   * @throws An error if transaction submission fails before it gets published
   */
  submitTx = async (
    accountAddress: string,
    quoteResponse: QuoteResponse<Trade, Trade> & QuoteMetadata,
    isStxEnabledOnClient: boolean,
    quotesReceivedContext?: RequiredEventContextFromClient[UnifiedSwapBridgeEventName.QuotesReceived],
    location: MetaMetricsSwapsEventSource = MetaMetricsSwapsEventSource.MainView,
    abTests?: Record<string, string>,
    activeAbTests?: { key: string; value: string }[],
  ): Promise<TransactionMeta & Partial<SolanaTransactionMeta>> => {
    stopPollingForQuotes(
      this.messenger,
      quoteResponse.featureId,
      quotesReceivedContext,
    );

    const selectedAccount = getAccountByAddress(this.messenger, accountAddress);
    if (!selectedAccount) {
      throw new Error(
        'Failed to submit cross-chain swap transaction: undefined multichain account',
      );
    }

    const isHardwareAccount = isHardwareWallet(selectedAccount);
    /**
     * For hardware wallets on Mobile, this is fixes an issue where the Ledger does not get prompted for the 2nd approval.
     * Extension does not have this issue
     */
    const requireApproval =
      this.#clientId === BridgeClientId.MOBILE && isHardwareAccount;
    const startTime = Date.now();
    const isBridgeTx = isCrossChain(
      quoteResponse.quote.srcChainId,
      quoteResponse.quote.destChainId,
    );

    const preConfirmationProperties = getPreConfirmationPropertiesFromQuote(
      quoteResponse,
      isStxEnabledOnClient,
      isHardwareAccount,
      location,
      abTests,
      activeAbTests,
    );

    let tradeTxMeta: TransactionMeta;

    try {
      // Emit Submitted event after submit button is clicked
      !quoteResponse.featureId &&
        this.#trackUnifiedSwapBridgeEvent(
          UnifiedSwapBridgeEventName.Submitted,
          undefined,
          preConfirmationProperties,
        );
      return await this.#trace(
        getTraceParams(quoteResponse, isStxEnabledOnClient),
        async () => {
          /**
           * Check if the account is an EIP-7702 delegated account.
           * Delegated accounts only allow 1 in-flight tx, so approve + swap
           * must be batched into a single transaction
           */
          const isDelegatedAccount = isNonEvmChainId(
            quoteResponse.quote.srcChainId,
          )
            ? false
            : await checkIsDelegatedAccount(
                this.messenger,
                selectedAccount.address as Hex,
                [formatChainIdToHex(quoteResponse.quote.srcChainId)],
              );

          const params: SubmitStrategyParams = {
            quoteResponse,
            isStxEnabledOnClient,
            isDelegatedAccount,
            messenger: this.messenger,
            selectedAccount,
            traceFn: this.#trace,
            requireApproval,
            isBridgeTx,
            clientId: this.#clientId,
            fetchFn: this.#fetchFn,
            bridgeApiBaseUrl: this.#config.customBridgeApiBaseUrl,
            addTransactionBatchFn: this.#addTransactionBatchFn,
          };
          const steps = executeSubmitFlow(params);

          // Each submission strategy determines when to return values, which means these values can be returned in any order
          for await (const { type, payload } of steps) {
            if (type === 'rekeyHistoryItem') {
              this.#rekeyHistoryItem(payload.actionId, payload.tradeMeta);
            }
            if (type === 'setTradeMeta') {
              tradeTxMeta = payload;
            }

            // Non-blocking steps
            try {
              if (type === 'addHistoryItem') {
                this.#addTxToHistory({
                  ...payload,
                  quoteResponse,
                  accountAddress: selectedAccount.address,
                  isStxEnabled: isStxEnabledOnClient,
                  startTime,
                  location,
                  abTests,
                  activeAbTests,
                  slippagePercentage: 0, // TODO include slippage provided by quote if using dynamic slippage, or slippage from quote request
                });
              }
              if (type === 'startPolling') {
                this.#startPollingForTxId(payload);
              }
              if (type === 'publishCompletedEvent') {
                this.#trackUnifiedSwapBridgeEvent(
                  UnifiedSwapBridgeEventName.Completed,
                  payload,
                );
              }
            } catch (error) {
              console.error(
                'Failed to add to bridge history and start polling',
                error,
              );
            }
          }

          return tradeTxMeta;
        },
      );
    } catch (error) {
      if (!quoteResponse.featureId) {
        this.#trackUnifiedSwapBridgeEvent(
          UnifiedSwapBridgeEventName.Failed,
          undefined,
          {
            error_message: (error as Error)?.message,
            ...preConfirmationProperties,
          },
        );
      }
      throw error;
    }
  };

  /**
   * Submits an intent order and creates a synthetic history entry for UX.
   * The EIP-712 payload is always signed inside this controller via KeyringController.
   *
   * @param params - Object containing intent submission parameters
   * @param params.quoteResponse - Quote carrying intent data
   * @param params.accountAddress - The EOA submitting the order
   * @param params.location - The entry point from which the user initiated the swap or bridge
   * @param params.abTests - Legacy A/B test context for `ab_tests` (backward compatibility)
   * @param params.activeAbTests - New A/B test context for `active_ab_tests` (migration target). Attributes events to specific experiments.
   * @param params.isStxEnabledOnClient - Whether smart transactions are enabled on the client, for example the getSmartTransactionsEnabled selector value from the extension
   * @param params.quotesReceivedContext - The context for the QuotesReceived event
   * @returns A lightweight TransactionMeta-like object for history linking
   * @throws An error if intent or transaction submission fails before they get published
   */
  submitIntent = async (params: {
    quoteResponse: QuoteResponse<Trade, Trade> & QuoteMetadata;
    accountAddress: string;
    location?: MetaMetricsSwapsEventSource;
    abTests?: Record<string, string>;
    activeAbTests?: { key: string; value: string }[];
    isStxEnabledOnClient?: boolean;
    quotesReceivedContext?: RequiredEventContextFromClient[UnifiedSwapBridgeEventName.QuotesReceived];
  }): Promise<Pick<TransactionMeta, 'id' | 'chainId' | 'type' | 'status'>> => {
    const {
      quoteResponse,
      accountAddress,
      location,
      abTests,
      activeAbTests,
      isStxEnabledOnClient,
      quotesReceivedContext,
    } = params;

    // TODO add metrics context
    return await this.submitTx(
      accountAddress,
      quoteResponse,
      Boolean(isStxEnabledOnClient),
      quotesReceivedContext,
      location,
      abTests,
      activeAbTests,
    );
  };

  /**
   * Tracks post-submission events for a cross-chain swap based on the history item
   *
   * @param eventName - The name of the event to track
   * @param txMetaId - The txMetaId of the history item to track the event for
   * @param eventProperties - The properties for the event
   */
  readonly #trackUnifiedSwapBridgeEvent = <
    EventName extends
      | typeof UnifiedSwapBridgeEventName.Submitted
      | typeof UnifiedSwapBridgeEventName.Failed
      | typeof UnifiedSwapBridgeEventName.Completed
      | typeof UnifiedSwapBridgeEventName.StatusValidationFailed
      | typeof UnifiedSwapBridgeEventName.PollingStatusUpdated,
  >(
    eventName: EventName,
    txMetaId?: string,
    eventProperties?: Pick<
      RequiredEventContextFromClient,
      EventName
    >[EventName],
  ): void => {
    // Legacy/new metrics fields are intentionally kept independent during migration.
    const historyAbTests = txMetaId
      ? this.state.txHistory?.[txMetaId]?.abTests
      : undefined;
    const historyActiveAbTests = txMetaId
      ? this.state.txHistory?.[txMetaId]?.activeAbTests
      : undefined;
    const resolvedAbTests = eventProperties?.ab_tests ?? historyAbTests;
    const resolvedActiveAbTests =
      eventProperties?.active_ab_tests ?? historyActiveAbTests;

    const baseProperties = {
      action_type: MetricsActionType.SWAPBRIDGE_V1,
      location:
        eventProperties?.location ??
        (txMetaId ? this.state.txHistory?.[txMetaId]?.location : undefined) ??
        MetaMetricsSwapsEventSource.MainView,
      ...(eventProperties ?? {}),
      ...(resolvedAbTests &&
        Object.keys(resolvedAbTests).length > 0 && {
          ab_tests: resolvedAbTests,
        }),
      ...(resolvedActiveAbTests &&
        resolvedActiveAbTests.length > 0 && {
          active_ab_tests: resolvedActiveAbTests,
        }),
    };

    // This will publish events for PERPS dropped tx failures as well
    if (!txMetaId) {
      trackMetricsEvent({
        messenger: this.messenger,
        eventName,
        properties: baseProperties,
      });
      return;
    }

    const historyItem: BridgeHistoryItem | undefined =
      this.state.txHistory[txMetaId];

    if (!historyItem) {
      trackMetricsEvent({
        messenger: this.messenger,
        eventName,
        properties: baseProperties,
      });
      return;
    }

    const { featureId, approvalTxId, quote } = historyItem;
    const requestParamProperties = getRequestParamFromHistory(historyItem);
    // Always publish StatusValidationFailed event, regardless of featureId
    if (eventName === UnifiedSwapBridgeEventName.StatusValidationFailed) {
      trackMetricsEvent({
        messenger: this.messenger,
        eventName,
        properties: {
          ...baseProperties,
          chain_id_source: requestParamProperties.chain_id_source,
          chain_id_destination: requestParamProperties.chain_id_destination,
          token_address_source: requestParamProperties.token_address_source,
          token_address_destination:
            requestParamProperties.token_address_destination,
          refresh_count: historyItem.attempts?.counter ?? 0,
        },
      });
      return;
    }

    // Skip tracking all other events when featureId is set (i.e. PERPS)
    if (featureId) {
      return;
    }

    const selectedAccount = getAccountByAddress(
      this.messenger,
      historyItem.account,
    );

    const transactions = getTransactions(this.messenger);
    const txMeta = transactions.find(
      (tx: TransactionMeta) => tx.id === txMetaId,
    );
    const approvalTxMeta = transactions.find(
      (tx: TransactionMeta) => tx.id === approvalTxId,
    );

    const requiredEventProperties = {
      ...baseProperties,
      ...requestParamProperties,
      ...getRequestMetadataFromHistory(historyItem, selectedAccount),
      ...getTradeDataFromHistory(historyItem),
      ...getTxStatusesFromHistory(historyItem),
      ...getFinalizedTxProperties(historyItem, txMeta, approvalTxMeta),
      ...getPriceImpactFromQuote(quote),
    };

    trackMetricsEvent({
      messenger: this.messenger,
      eventName,
      properties: requiredEventProperties,
    });
  };
}
