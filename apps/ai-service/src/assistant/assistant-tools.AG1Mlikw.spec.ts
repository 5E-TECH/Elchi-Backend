import { of } from 'rxjs';
import { AssistantReader } from './assistant-reader';
import {
  assistantToolDefinitions,
  executeAssistantTool,
} from './assistant-tools';

/**
 * AG1Mlikw (T6-BE-1 #6) — AI «Oldi-berdi» filtri yangi turni taniydi:
 * `payment_reversal` tool sxemasida ham, kirish tekshiruvida ham bor.
 */
describe('AG1Mlikw — get_cashbox_history source_type', () => {
  it('sxema enum ida `payment_reversal` bor', () => {
    const tool = assistantToolDefinitions(['superadmin']).find(
      (item) => item.name === 'get_cashbox_history',
    ) as unknown as {
      input_schema: {
        properties: { source_type: { enum: string[] } };
      };
    };
    expect(tool.input_schema.properties.source_type.enum).toContain(
      'payment_reversal',
    );
  });

  it('kirishda `payment_reversal` finance filtriga uzatiladi', async () => {
    const finance = {
      send: jest.fn(() => of({ data: { items: [], summary: {} } })),
    };
    const reader = new AssistantReader(
      finance as never,
      { send: jest.fn() } as never,
      { send: jest.fn() } as never,
    );
    await executeAssistantTool(
      'get_cashbox_history',
      { source_type: 'payment_reversal' },
      {
        reader,
        requester: { id: '1', roles: ['superadmin'] },
        today: '2026-10-31',
      },
    );
    expect(finance.send).toHaveBeenCalledWith(
      { cmd: 'finance.history.find_all' },
      expect.objectContaining({ source_type: 'payment_reversal' }),
    );
  });
});
