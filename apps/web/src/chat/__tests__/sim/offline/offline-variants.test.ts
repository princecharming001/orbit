/** The offline chat simulation without Gmail, without LinkedIn, and on an empty account (see suite.ts). */
import { offlineSuite } from './suite';

offlineSuite('variants', ['student-nogmail', 'student-nolinkedin', 'empty']);
