/**
 * The desktop renderer's stylesheet. Every renderer entry imports this
 * module, never `globals.css` itself: the stylesheet's responsive rules
 * only apply once the attributes installed here are set.
 */
import './globals.css';
import { installViewportQueryAttributes } from './viewport-query-attributes';

installViewportQueryAttributes();
