import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { InternalTokenGuard } from '../security/internal-token.guard';
import { ReservationsService } from './reservations.service';
import { ReleaseDto } from './release.dto';
import { ReserveDto } from './reserve.dto';

@Controller('internal/reservations')
@UseGuards(InternalTokenGuard)
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Post()
  async reserve(@Body() dto: ReserveDto) {
    const result = await this.reservations.reserve(dto);
    if (result.status === 'rejected') {
      throw new UnprocessableEntityException({
        code: 'INSUFFICIENT_FUNDS',
        message: 'Недостатньо коштів',
      });
    }
    return result;
  }

  @Post(':id/release')
  @HttpCode(200)
  release(@Param('id', ParseUUIDPipe) id: string) {
    return this.reservations.release(id);
  }

  @Post(':id/release-closed')
  @HttpCode(200)
  releaseClosed(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReleaseDto) {
    return this.reservations.release(id, BigInt(dto.amount));
  }
}
