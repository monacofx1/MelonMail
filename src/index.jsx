import React from 'react';
import { render } from 'react-dom';
import { AppContainer } from 'react-hot-loader';

import MelonMail from './MelonMail/';

render((<AppContainer><MelonMail defaultDomain="decenter-test.test" /></AppContainer>), document.getElementById('app'));

module.hot.accept();
