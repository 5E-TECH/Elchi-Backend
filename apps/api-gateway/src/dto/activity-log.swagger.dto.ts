import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Min } from 'class-validator';

/**
 * Query filters for the admin audit-log viewer (GET /activity-logs).
 * `service` narrows the fan-in to one schema (and makes pagination exact);
 * omitting it merges across all audited services.
 */
export class ActivityLogQueryDto {
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 20, description: 'Max 100' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Restrict to one service schema',
    enum: ['identity', 'order', 'finance', 'branch', 'integration', 'logistics', 'catalog', 'investor', 'notification'],
  })
  @IsOptional()
  @IsString()
  service?: string;

  @ApiPropertyOptional({ example: 'Order', description: 'entity_type filter' })
  @IsOptional()
  @IsString()
  entity_type?: string;

  @ApiPropertyOptional({ example: '123' })
  @IsOptional()
  @IsString()
  entity_id?: string;

  @ApiPropertyOptional({ example: 'status_change' })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({ description: 'Actor user id' })
  @IsOptional()
  @IsString()
  user_id?: string;

  @ApiPropertyOptional({ description: 'Actor role contains' })
  @IsOptional()
  @IsString()
  user_role?: string;

  @ApiPropertyOptional({ description: 'Correlation id' })
  @IsOptional()
  @IsString()
  trace_id?: string;

  @ApiPropertyOptional({ description: 'created_at lower bound (ISO date or datetime)' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'created_at upper bound (ISO date or datetime)' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ description: 'Free-text across type/id/action/actor name' })
  @IsOptional()
  @IsString()
  search?: string;
}
