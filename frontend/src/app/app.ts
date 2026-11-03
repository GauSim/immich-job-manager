import { Component, computed, inject, type OnInit } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { HealthStore } from './core/health.store';

@Component({
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatToolbarModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
  ],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App implements OnInit {
  protected readonly title = 'Immich Album Jobs';
  private readonly healthStore = inject(HealthStore);

  protected readonly immich = computed(() => {
    if (this.healthStore.unreachable())
      return { state: 'down', label: 'Server unreachable', tip: '' };
    const h = this.healthStore.health();
    if (!h) return { state: 'unknown', label: 'Checking…', tip: '' };
    if (h.immich.status === 'up')
      return { state: 'up', label: 'Immich connected', tip: `Immich ${h.immich.version}` };
    if (h.immich.status === 'incompatible')
      return { state: 'down', label: 'Immich incompatible', tip: h.immich.error ?? '' };
    return { state: 'down', label: 'Immich unreachable', tip: h.immich.error ?? '' };
  });

  ngOnInit(): void {
    this.healthStore.start();
  }
}
