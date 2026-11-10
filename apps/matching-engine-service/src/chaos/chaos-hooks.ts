import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsBoolean, IsIn, IsInt, IsOptional, Min } from 'class-validator';

export class ArmChaosDto {
  @IsIn([
    'after_writes_before_commit',
    'after_commit_before_memory',
    'stall_before_commit',
    'freeze_stream_reader',
    'unfreeze_stream_reader',
  ])
  point!: string;
  @IsOptional() @IsInt() @Min(1) fromSeq?: number;
  @IsOptional() @IsBoolean() requireTrades?: boolean;
}

@Injectable()
export class ChaosHooks {
  private armed?: ArmChaosDto;
  private frozenReader = false;
  constructor(private readonly config: ConfigService) {}

  /** Поки `true`, WebSocket-репліка не читає stream: так відтворюється завислий XREAD-цикл. */
  get readerFrozen(): boolean {
    return this.frozenReader;
  }

  arm(input: ArmChaosDto) {
    if (!this.config.getOrThrow<boolean>('CHAOS_ENABLED')) throw new BadRequestException();
    if (input.point === 'freeze_stream_reader' || input.point === 'unfreeze_stream_reader') {
      this.frozenReader = input.point === 'freeze_stream_reader';
      return { armed: input.point };
    }
    this.armed = { ...input };
    return { armed: input.point };
  }
  async reach(point: string, seq: string, trades: number): Promise<void> {
    const armed = this.armed;
    if (
      !armed ||
      armed.point !== point ||
      BigInt(seq) < BigInt(armed.fromSeq ?? 1) ||
      (armed.requireTrades && !trades)
    )
      return;
    this.armed = undefined;
    if (point === 'stall_before_commit') {
      await new Promise((resolve) =>
        setTimeout(resolve, this.config.getOrThrow<number>('CHAOS_STALL_BEFORE_COMMIT_MS')),
      );
    } else process.kill(process.pid, 'SIGKILL');
  }
}
