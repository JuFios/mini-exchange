import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OrdersService } from './orders.service';
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
  constructor(private readonly orders: OrdersService) {}

  @Post()
  submit(@Body() dto: SubmitOrderDto, @Request() req: AuthenticatedRequest) {
    return this.orders.submitOrder(withExactAmounts(dto, req.rawBody), req.user.userId);
  }

  @Get()
  listOwn(@Request() req: AuthenticatedRequest) {
    return this.orders.listOwn(req.user.userId);
  }

  @Get('book')
  getDepth(@Query('instrument') instrument: string) {
    return this.orders.getDepth(instrument);
  }

  @Delete(':id')
  cancel(
    @Param('id') id: string,
    @Query('instrument') instrument: string | undefined,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.orders.cancelOrder(id, req.user.userId, instrument);
  }
}
