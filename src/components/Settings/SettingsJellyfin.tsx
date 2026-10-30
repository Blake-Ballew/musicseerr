import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import useSettings from '@app/hooks/useSettings';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { isValidURL } from '@app/utils/urlValidationHelper';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import type { JellyfinSettings } from '@server/lib/settings';
import axios from 'axios';
import { Field, Formik } from 'formik';
import { useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';
import useSWR from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings', {
  jellyfinsettings: '{mediaServerName} Settings',
  jellyfinsettingsDescription:
    'Configure the settings for your {mediaServerName} server. {mediaServerName} scans your {mediaServerName} libraries to see what content is available.',
  timeout: 'Timeout',
  save: 'Save Changes',
  saving: 'Saving…',
  musicAvailabilityNote:
    '{mediaServerName} is used for sign-in. Music availability is tracked through Lidarr, so there are no libraries to select or scan here.',
  jellyfinSettingsFailure:
    'Something went wrong while saving {mediaServerName} settings.',
  jellyfinSettingsSuccess: '{mediaServerName} settings saved successfully!',
  jellyfinSettings: '{mediaServerName} Settings',
  jellyfinSettingsDescription:
    'Optionally configure the internal and external endpoints for your {mediaServerName} server. In most cases, the external URL is different to the internal URL. A custom password reset URL can also be set for {mediaServerName} login, in case you would like to redirect to a different password reset page. You can also change the Jellyfin API key, which was automatically generated previously.',
  externalUrl: 'External URL',
  hostname: 'Hostname or IP Address',
  port: 'Port',
  enablessl: 'Use SSL',
  urlBase: 'URL Base',
  jellyfinForgotPasswordUrl: 'Forgot Password URL',
  apiKey: 'API key',
  invalidurlerror: 'Unable to connect to {mediaServerName} server.',
  validationUrl: 'You must provide a valid URL',
  validationHostnameRequired: 'You must provide a valid hostname or IP address',
  validationPortRequired: 'You must provide a valid port number',
  validationUrlTrailingSlash: 'URL must not end in a trailing slash',
  validationUrlBaseLeadingSlash: 'URL base must have a leading slash',
  validationUrlBaseTrailingSlash: 'URL base must not end in a trailing slash',
});

interface SettingsJellyfinProps {
  isSetupSettings?: boolean;
}

const SettingsJellyfin: React.FC<SettingsJellyfinProps> = ({
  isSetupSettings,
}) => {
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<JellyfinSettings>('/api/v1/settings/jellyfin');
  const intl = useIntl();
  const { addToast } = useToasts();
  const settings = useSettings();

  const JellyfinSettingsSchema = Yup.object().shape({
    hostname: Yup.string()
      .nullable()
      .required(intl.formatMessage(messages.validationHostnameRequired)),
    port: Yup.number().when(['hostname'], {
      is: (value: unknown) => !!value,
      then: Yup.number()
        .typeError(intl.formatMessage(messages.validationPortRequired))
        .nullable()
        .required(intl.formatMessage(messages.validationPortRequired)),
      otherwise: Yup.number()
        .typeError(intl.formatMessage(messages.validationPortRequired))
        .nullable(),
    }),
    urlBase: Yup.string()
      .test(
        'leading-slash',
        intl.formatMessage(messages.validationUrlBaseLeadingSlash),
        (value) => !value || value.startsWith('/')
      )
      .test(
        'trailing-slash',
        intl.formatMessage(messages.validationUrlBaseTrailingSlash),
        (value) => !value || !value.endsWith('/')
      ),
    jellyfinExternalUrl: Yup.string()
      .nullable()
      .test('valid-url', intl.formatMessage(messages.validationUrl), isValidURL)
      .test(
        'no-trailing-slash',
        intl.formatMessage(messages.validationUrlTrailingSlash),
        (value) => !value || !value.endsWith('/')
      ),
    jellyfinForgotPasswordUrl: Yup.string()
      .nullable()
      .test('valid-url', intl.formatMessage(messages.validationUrl), isValidURL)
      .test(
        'no-trailing-slash',
        intl.formatMessage(messages.validationUrlTrailingSlash),
        (value) => !value || !value.endsWith('/')
      ),
  });

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  const mediaServerFormatValues = {
    mediaServerName:
      settings.currentSettings.mediaServerType === MediaServerType.JELLYFIN
        ? 'Jellyfin'
        : settings.currentSettings.mediaServerType === MediaServerType.EMBY
          ? 'Emby'
          : undefined,
  };

  return (
    <>
      <div className="mb-6 rounded-md border border-gray-700 bg-gray-800/50 p-4 text-sm text-gray-400">
        {intl.formatMessage(
          messages.musicAvailabilityNote,
          mediaServerFormatValues
        )}
      </div>
      <div className="mb-6 mt-10">
        <h3 className="heading">
          {intl.formatMessage(
            messages.jellyfinSettings,
            mediaServerFormatValues
          )}
        </h3>
        <p className="description">
          {intl.formatMessage(
            messages.jellyfinSettingsDescription,
            mediaServerFormatValues
          )}
        </p>
      </div>
      <Formik
        initialValues={{
          hostname: data?.ip,
          port: data?.port ?? 8096,
          useSsl: data?.useSsl,
          urlBase: data?.urlBase || '',
          jellyfinExternalUrl: data?.externalHostname || '',
          jellyfinForgotPasswordUrl: data?.jellyfinForgotPasswordUrl || '',
          apiKey: data?.apiKey,
        }}
        validationSchema={JellyfinSettingsSchema}
        onSubmit={async (values) => {
          try {
            await axios.post('/api/v1/settings/jellyfin', {
              ip: values.hostname,
              port: Number(values.port),
              useSsl: values.useSsl,
              urlBase: values.urlBase,
              externalHostname: values.jellyfinExternalUrl,
              jellyfinForgotPasswordUrl: values.jellyfinForgotPasswordUrl,
              apiKey: values.apiKey,
            } as JellyfinSettings);

            addToast(
              intl.formatMessage(
                messages.jellyfinSettingsSuccess,
                mediaServerFormatValues
              ),
              {
                autoDismiss: true,
                appearance: 'success',
              }
            );
          } catch (e) {
            if (e?.response?.data?.message === ApiErrorCode.InvalidUrl) {
              addToast(
                intl.formatMessage(
                  messages.invalidurlerror,
                  mediaServerFormatValues
                ),
                {
                  autoDismiss: true,
                  appearance: 'error',
                }
              );
            } else {
              addToast(
                intl.formatMessage(
                  messages.jellyfinSettingsFailure,
                  mediaServerFormatValues
                ),
                {
                  autoDismiss: true,
                  appearance: 'error',
                }
              );
            }
          } finally {
            revalidate();
          }
        }}
      >
        {({
          errors,
          touched,
          values,
          setFieldValue,
          handleSubmit,
          isSubmitting,
          isValid,
        }) => {
          return (
            <form className="section" onSubmit={handleSubmit}>
              {!isSetupSettings && (
                <>
                  <div className="form-row">
                    <label htmlFor="hostname" className="text-label">
                      {intl.formatMessage(messages.hostname)}
                      <span className="text-red-500">*</span>
                    </label>
                    <div className="form-input-area">
                      <div className="form-input-field">
                        <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100 sm:text-sm">
                          {values.useSsl ? 'https://' : 'http://'}
                        </span>
                        <Field
                          type="text"
                          inputMode="url"
                          id="hostname"
                          name="hostname"
                          className="rounded-r-only"
                        />
                      </div>
                      {errors.hostname &&
                        touched.hostname &&
                        typeof errors.hostname === 'string' && (
                          <div className="error">{errors.hostname}</div>
                        )}
                    </div>
                  </div>
                  <div className="form-row">
                    <label htmlFor="port" className="text-label">
                      {intl.formatMessage(messages.port)}
                      <span className="label-required">*</span>
                    </label>
                    <div className="form-input-area">
                      <Field
                        type="text"
                        inputMode="numeric"
                        id="port"
                        name="port"
                        className="short"
                      />
                      {errors.port &&
                        touched.port &&
                        typeof errors.port === 'string' && (
                          <div className="error">{errors.port}</div>
                        )}
                    </div>
                  </div>
                  <div className="form-row">
                    <label htmlFor="useSsl" className="checkbox-label">
                      {intl.formatMessage(messages.enablessl)}
                    </label>
                    <div className="form-input-area">
                      <Field
                        type="checkbox"
                        id="useSsl"
                        name="useSsl"
                        onChange={() => {
                          setFieldValue('useSsl', !values.useSsl);
                          setFieldValue('port', values.useSsl ? 8096 : 443);
                        }}
                      />
                    </div>
                  </div>
                </>
              )}
              <div className="form-row">
                <label htmlFor="apiKey" className="text-label">
                  {intl.formatMessage(messages.apiKey)}
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <SensitiveInput
                      as="field"
                      type="text"
                      inputMode="url"
                      id="apiKey"
                      name="apiKey"
                    />
                  </div>
                  {errors.apiKey && touched.apiKey && (
                    <div className="error">{errors.apiKey}</div>
                  )}
                </div>
              </div>
              {!isSetupSettings && (
                <>
                  <div className="form-row">
                    <label htmlFor="urlBase" className="text-label">
                      {intl.formatMessage(messages.urlBase)}
                    </label>
                    <div className="form-input-area">
                      <div className="form-input-field">
                        <Field
                          type="text"
                          inputMode="url"
                          id="urlBase"
                          name="urlBase"
                        />
                      </div>
                      {errors.urlBase &&
                        touched.urlBase &&
                        typeof errors.urlBase === 'string' && (
                          <div className="error">{errors.urlBase}</div>
                        )}
                    </div>
                  </div>
                </>
              )}
              <div className="form-row">
                <label htmlFor="jellyfinExternalUrl" className="text-label">
                  {intl.formatMessage(messages.externalUrl)}
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      type="text"
                      inputMode="url"
                      id="jellyfinExternalUrl"
                      name="jellyfinExternalUrl"
                    />
                  </div>
                  {errors.jellyfinExternalUrl &&
                    touched.jellyfinExternalUrl && (
                      <div className="error">{errors.jellyfinExternalUrl}</div>
                    )}
                </div>
              </div>
              <div className="form-row">
                <label
                  htmlFor="jellyfinForgotPasswordUrl"
                  className="text-label"
                >
                  {intl.formatMessage(messages.jellyfinForgotPasswordUrl)}
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      type="text"
                      inputMode="url"
                      id="jellyfinForgotPasswordUrl"
                      name="jellyfinForgotPasswordUrl"
                    />
                  </div>
                  {errors.jellyfinForgotPasswordUrl &&
                    touched.jellyfinForgotPasswordUrl && (
                      <div className="error">
                        {errors.jellyfinForgotPasswordUrl}
                      </div>
                    )}
                </div>
              </div>
              <div
                className={`actions ${isSetupSettings ? 'mt-0 border-0' : ''}`}
              >
                <div className="flex justify-end">
                  <span className="ml-3 inline-flex rounded-md shadow-sm">
                    <Button
                      buttonType="primary"
                      type="submit"
                      disabled={isSubmitting || !isValid}
                    >
                      <ArrowDownOnSquareIcon />
                      <span>
                        {isSubmitting
                          ? intl.formatMessage(globalMessages.saving)
                          : intl.formatMessage(globalMessages.save)}
                      </span>
                    </Button>
                  </span>
                </div>
              </div>
            </form>
          );
        }}
      </Formik>
    </>
  );
};

export default SettingsJellyfin;
