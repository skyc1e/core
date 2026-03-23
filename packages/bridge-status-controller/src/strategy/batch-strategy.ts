import { TxData } from '@metamask/bridge-controller';

import type { SubmitStrategyParams, SubmitStepResult } from './types';
import {
  addTransactionBatch,
  getAddTransactionBatchParams,
} from '../utils/transaction';

/**
 * Submits batched EVM transactions to the TransactionController
 *
 * @param args - The parameters for the transaction
 * @yields The approvalMeta and tradeMeta for the batched transaction
 */
export async function* submitBatchHandler(
  args: SubmitStrategyParams<TxData>,
): AsyncGenerator<SubmitStepResult, void, void> {
  const {
    requireApproval,
    quoteResponse,
    messenger,
    isBridgeTx,
    addTransactionBatchFn,
  } = args;
  const transactionParams = await getAddTransactionBatchParams({
    messenger,
    isBridgeTx,
    resetApproval: quoteResponse.resetApproval,
    approval: quoteResponse.approval,
    trade: quoteResponse.trade,
    quoteResponse,
    requireApproval,
  });

  const { approvalMeta, tradeMeta } = await addTransactionBatch(
    messenger,
    addTransactionBatchFn,
    transactionParams,
  );

  yield {
    type: 'setTradeMeta',
    payload: tradeMeta,
  };

  yield {
    type: 'addHistoryItem',
    payload: {
      approvalTxId: approvalMeta?.id,
      bridgeTxMeta: {
        id: tradeMeta.id,
        hash: tradeMeta.hash,
        batchId: tradeMeta.batchId,
      },
    },
  };
}
