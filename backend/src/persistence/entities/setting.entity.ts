import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Non-secret runtime settings (retention, defaults, UI preferences). */
@Entity('setting')
export class SettingEntity {
  @PrimaryColumn('text')
  key: string;

  @Column('simple-json')
  value: unknown;
}
