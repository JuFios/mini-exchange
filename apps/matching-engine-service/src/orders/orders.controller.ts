import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Res,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { ListOrdersQueryDto } from './dto/list-orders-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OrdersService } from './orders.service';
import { CancelOrderQueryDto } from './dto/cancel-order-query.dto';
import { InstrumentCatalog } from './instrument-catalog';
import { SubmitOrderDto } from './dto/submit-order.dto';
import { plainDecimal, topLevelNumberLexemes } from './amount-lexemes';

interface AuthenticatedRequest {
  user: { userId: string; email: string };
  // Заповнюється, коли застосунок створено з `rawBody: true`.
  rawBody?: Buffer;
}

const AMOUNT_FIELDS = ['price', 'quantity'] as const;

// JSON.parse округлює число до double, тому 1000000.00000000001 виглядає як 1000000.
// Для чисел беремо точний запис із тіла запиту, щоб строгий парсер побачив усі знаки.
function withExactAmounts(dto: SubmitOrderDto, rawBody?: Buffer): SubmitOrderDto {
  if (!rawBody) return dto;
  let lexemes: Map<string, string>;
  try {
    lexemes = topLevelNumberLexemes(rawBody.toString('utf8'));
  } catch {
    throw new BadRequestException('Некоректне тіло запиту');
  }
  const exact = { ...dto };
  for (const field of AMOUNT_FIELDS) {
    const lexeme = lexemes.get(field);
    if (typeof dto[field] === 'number' && lexeme !== undefined) {
      exact[field] = plainDecimal(lexeme);
    }
  }
  return exact;
}

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly instruments: InstrumentCatalog,
  ) {}

  @Post()
  async submit(@Body() dto: SubmitOrderDto, @Request() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string | undefined, @Headers('traceparent') traceparent: string | undefined,
    @Res({ passthrough: true }) response: Response) {
    this.instruments.require(dto.instrument);
    const result = await this.orders.submitOrder(withExactAmounts(dto, req.rawBody), req.user.userId, key, traceparent);
    response.status(result.status);
    return result.body;
  }

  @Get()
  listOwn(@Request() req: AuthenticatedRequest, @Query() query: ListOrdersQueryDto) {
    return this.orders.listOwn(req.user.userId, query);
  }

  @Get(':id')
  getOwn(@Param('id', new ParseUUIDPipe({ exceptionFactory: () => new BadRequestException('Некоректний ідентифікатор заявки') })) id: string, @Request() req: AuthenticatedRequest) {
    return this.orders.getOwn(id, req.user.userId);
  }

  @Delete(':id')
  async cancel(
    @Param('id', new ParseUUIDPipe({
      exceptionFactory: () => new BadRequestException('Некоректний ідентифікатор заявки'),
    })) id: string,
    @Query() query: CancelOrderQueryDto,
    @Request() req: AuthenticatedRequest,
    @Headers('traceparent') traceparent: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.orders.cancelOrder(id, req.user.userId, query.instrument, traceparent);
    response.status(result.status);
    return result.body;
  }
}
