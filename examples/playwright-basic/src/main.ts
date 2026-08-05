import { addToCart } from './cart';
import { showProfile } from './profile';

const out = document.querySelector('#out') as HTMLElement;
document.querySelector('#cart')?.addEventListener('click', () => {
  out.textContent = addToCart();
});
document.querySelector('#profile')?.addEventListener('click', () => {
  out.textContent = showProfile();
});
