import { Component, computed, inject, type OnInit } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthStore } from './core/auth.store';
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
    if (!h?.immich) return { state: 'unknown', label: 'Checking…', tip: '' };
    if (h.immich.status === 'up')
      return { state: 'up', label: 'Immich connected', tip: `Immich ${h.immich.version}` };
    if (h.immich.status === 'incompatible')
      return { state: 'down', label: 'Immich incompatible', tip: h.immich.error ?? '' };
    return { state: 'down', label: 'Immich unreachable', tip: h.immich.error ?? '' };
  });

  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  /** Nav, status and logout only make sense with a session. */
  protected readonly signedIn = computed(() => this.auth.session()?.authenticated === true);
  protected readonly canLogout = computed(
    () => this.signedIn() && this.auth.session()?.mode === 'password',
  );

  async logout(): Promise<void> {
    await this.auth.logout();
    await this.router.navigate(['/login']);
  }

  ngOnInit(): void {
    this.healthStore.start();
  }
}
