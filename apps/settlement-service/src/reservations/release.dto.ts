import { IsDefined, Matches } from 'class-validator';

export class ReleaseDto {
  @IsDefined()
  @Matches(/^[1-9][0-9]{0,37}(?![\s\S])/)
  amount: string;
}
