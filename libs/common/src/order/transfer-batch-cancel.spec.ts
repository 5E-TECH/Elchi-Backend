import { BranchTransferBatchStatus } from '../../enums';
import {
  TRANSFER_BATCH_CANCEL_REASONS,
  transferBatchCancelBlock,
} from './transfer-batch-cancel';

/** oP02jE2P — faqat jo'natilmagan (PENDING) paket bekor qilinadi. */
describe('oP02jE2P — transferBatchCancelBlock', () => {
  it('PENDING → ruxsat (null), harf registri va bo‘shliq farq qilmaydi', () => {
    expect(transferBatchCancelBlock(BranchTransferBatchStatus.PENDING)).toBe(
      null,
    );
    expect(transferBatchCancelBlock(' pending ')).toBe(null);
  });

  it("SENT (yo'lda) → 409 batch_in_transit, o'zbekcha matn", () => {
    expect(transferBatchCancelBlock(BranchTransferBatchStatus.SENT)).toEqual({
      statusCode: 409,
      message: expect.stringMatching(/^Paket yo'lda/),
      reason: TRANSFER_BATCH_CANCEL_REASONS.IN_TRANSIT,
    });
  });

  it.each([
    [BranchTransferBatchStatus.RECEIVED, 'batch_received'],
    [BranchTransferBatchStatus.CANCELLED, 'batch_already_cancelled'],
    ['SOMETHING_ELSE', 'batch_not_cancellable'],
    [undefined, 'batch_not_cancellable'],
  ])('%s → 400 %s', (status, reason) => {
    expect(transferBatchCancelBlock(status)).toEqual(
      expect.objectContaining({ statusCode: 400, reason }),
    );
  });

  it("matnda status kodi yoki inglizcha holat nomi yo'q", () => {
    for (const status of Object.values(BranchTransferBatchStatus)) {
      const block = transferBatchCancelBlock(status);
      if (!block) continue;
      expect(block.message).not.toMatch(/\(\d{3}\)|SENT|RECEIVED|CANCELLED/);
    }
  });
});
