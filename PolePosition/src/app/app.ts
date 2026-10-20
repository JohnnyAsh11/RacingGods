import { Component, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { OpenF1Client } from '../api/openf1.client';

@Component({
  imports: [],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  private readonly client = inject(OpenF1Client);
  protected readonly title = signal('Racing Gods');

  constructor() {
    this.client.latestSession().subscribe((sessions) => {
      const session = sessions[0];
      if (session) {
        this.client.snapshot(session).subscribe({
          next: (snapshot) => console.log('OpenF1 snapshot:', snapshot),
          error: (error) => console.error('Unable to load OpenF1 snapshot:', error),
        });
      }
    });
  }
}
