import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * `logistics.post.reassign_branch` — jo'natilgan filial pochtasini boshqa
 * filialga o'tkazishning pochta qismi: faqat hali 'sent', kuryersiz va AYNAN
 * eski filialdagi pochta o'zgaradi (shartli yozuv).
 */
function setup(post: Record<string, unknown> | null, affected: number) {
  const postRepo = {
    update: jest.fn().mockResolvedValue({ affected }),
    findOne: jest.fn().mockResolvedValue(post),
  };
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  const client = () =>
    ({ send: jest.fn(() => of({})), emit: jest.fn(() => of({})) }) as any;
  const service = new LogisticsServiceService(
    postRepo as any,
    {} as any,
    {} as any,
    client(),
    client(),
    client(),
    client(),
    activityLog as any,
  );
  jest.spyOn(service as any, 'syncPostToSearch').mockResolvedValue(undefined);
  return { service, postRepo, activityLog };
}

const statusOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return undefined;
  } catch (err) {
    expect(err).toBeInstanceOf(RpcException);
    return ((err as RpcException).getError() as { statusCode?: number })
      .statusCode;
  }
};

describe('reassignPostBranch', () => {
  it("shartli yozuv: faqat 'sent', kuryersiz, eski filialdagi pochta", async () => {
    const { service, postRepo, activityLog } = setup(
      { id: '900', status: 'sent', branch_id: '22', isDeleted: false },
      1,
    );
    const res: any = await service.reassignPostBranch('900', '20', '22');
    expect(postRepo.update).toHaveBeenCalledWith(
      {
        id: '900',
        status: 'sent',
        courier_id: '0',
        branch_id: '20',
        isDeleted: false,
      },
      { branch_id: '22' },
    );
    expect(res.data.branch_id).toBe('22');
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'Post',
        entity_id: '900',
        action: 'logistics.post_reassign_branch',
        metadata: { from_branch_id: '20', to_branch_id: '22' },
      }),
    );
  });

  it('pochta allaqachon yangi filialda (o`zi tiklangan / qayta urinish) — muvaffaqiyat', async () => {
    const { service } = setup(
      { id: '900', status: 'sent', branch_id: '22', isDeleted: false },
      0,
    );
    expect(await statusOf(service.reassignPostBranch('900', '20', '22'))).toBe(
      undefined,
    );
  });

  it('shu orada qabul qilingan yoki boshqa filialga o`tgan — 409', async () => {
    const received = setup(
      { id: '900', status: 'received', branch_id: '20', isDeleted: false },
      0,
    );
    expect(
      await statusOf(received.service.reassignPostBranch('900', '20', '22')),
    ).toBe(409);
    const elsewhere = setup(
      { id: '900', status: 'sent', branch_id: '40', isDeleted: false },
      0,
    );
    expect(
      await statusOf(elsewhere.service.reassignPostBranch('900', '20', '22')),
    ).toBe(409);
  });

  it('pochta yo`q — 404; noto`g`ri id — 400 (yozuvsiz)', async () => {
    const missing = setup(null, 0);
    expect(
      await statusOf(missing.service.reassignPostBranch('900', '20', '22')),
    ).toBe(404);
    const bad = setup(null, 0);
    expect(
      await statusOf(bad.service.reassignPostBranch('900', '', '22')),
    ).toBe(400);
    expect(bad.postRepo.update).not.toHaveBeenCalled();
  });
});
