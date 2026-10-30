import defineMessages from '@app/utils/defineMessages';
import {
  CheckCircleIcon,
  ChevronDownIcon,
  XCircleIcon,
} from '@heroicons/react/24/solid';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.MusicUpload.RipGuide', {
  title: 'How to rip a CD and upload it',
  intro:
    'It takes about 10 minutes per CD, and most of that is waiting. The ripper reads the disc, looks up the album online and names everything for you.',
  toolTitle: 'What to use',
  toolBody:
    '<strong>dBpoweramp CD Ripper</strong> (Windows and Mac) is the easiest. It has a free 21-day trial, then a one-time purchase. Free alternatives: <strong>Exact Audio Copy</strong> (Windows) or <strong>XLD</strong> (Mac). They work fine but take more setting up.',
  setupTitle: 'One-time setup in dBpoweramp',
  setup1:
    'Install it from <strong>dbpoweramp.com</strong> and open <strong>dBpoweramp CD Ripper</strong>.',
  setup2:
    'At the bottom, set <strong>Rip to</strong> to <strong>FLAC</strong>. Leave the compression level as it is.',
  setup3:
    "Leave <strong>AccurateRip</strong> on. It double-checks every track against other people's copies of the same CD.",
  stepsTitle: 'For each CD',
  step1: 'Put the CD in. The ripper looks it up and fills in the names.',
  step2:
    '<strong>Check the names</strong> against the CD case: artist, album and track titles. If it offers several matches, pick the one with the right year or edition (for example "Deluxe" or "Remastered").',
  step3:
    'Click <strong>Rip</strong> and wait. Every track should finish with "Accurate" or "Secure".',
  step4:
    "Open the folder it saved to. It's usually <strong>Music › Artist › Album</strong>.",
  step5:
    'Drag that <strong>album folder</strong> onto this page. We check the files, find the album and you click <strong>Add to library</strong>.',
  doTitle: 'Do',
  do1: 'Upload one album at a time.',
  do2: 'Upload every track on the album.',
  do3: 'Upload both discs of a 2-CD set together, as one album.',
  do4: 'Set the album artist to "Various Artists" for compilations and soundtracks.',
  do5: 'Already bought it as a download (Bandcamp etc.)? Pick FLAC, unzip it and upload the folder.',
  dontTitle: "Don't",
  dont1:
    'Rename the files or type in your own names, unless the ripper got them wrong.',
  dont2: 'Mix tracks from different albums in one upload.',
  dont3:
    'Upload one big file for the whole CD (an "image" with a .cue file). Rip to separate tracks instead.',
  after:
    'After you add an album it appears in Jellyfin and Finamp within a few minutes, with the artwork and names filled in.',
});

const RipGuide = ({ defaultOpen }: { defaultOpen: boolean }) => {
  const intl = useIntl();
  const [open, setOpen] = useState(defaultOpen);
  const rich = {
    strong: (msg: React.ReactNode) => (
      <strong className="font-semibold text-gray-100">{msg}</strong>
    ),
  };

  return (
    <div className="mb-6 rounded-xl bg-gray-800 ring-1 ring-gray-700">
      <button
        type="button"
        className="flex w-full items-center justify-between px-5 py-4 text-left"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="text-lg font-bold text-white">
          {intl.formatMessage(messages.title)}
        </span>
        <ChevronDownIcon
          className={`h-5 w-5 text-gray-400 transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      {open && (
        <div className="space-y-6 px-5 pb-6 text-sm leading-relaxed text-gray-300">
          <p>{intl.formatMessage(messages.intro)}</p>

          <section>
            <h3 className="mb-2 font-bold text-white">
              {intl.formatMessage(messages.toolTitle)}
            </h3>
            <p>{intl.formatMessage(messages.toolBody, rich)}</p>
          </section>

          <div className="grid gap-6 md:grid-cols-2">
            <section>
              <h3 className="mb-2 font-bold text-white">
                {intl.formatMessage(messages.setupTitle)}
              </h3>
              <ol className="list-decimal space-y-1 pl-5">
                <li>{intl.formatMessage(messages.setup1, rich)}</li>
                <li>{intl.formatMessage(messages.setup2, rich)}</li>
                <li>{intl.formatMessage(messages.setup3, rich)}</li>
              </ol>
            </section>
            <section>
              <h3 className="mb-2 font-bold text-white">
                {intl.formatMessage(messages.stepsTitle)}
              </h3>
              <ol className="list-decimal space-y-1 pl-5">
                <li>{intl.formatMessage(messages.step1, rich)}</li>
                <li>{intl.formatMessage(messages.step2, rich)}</li>
                <li>{intl.formatMessage(messages.step3, rich)}</li>
                <li>{intl.formatMessage(messages.step4, rich)}</li>
                <li>{intl.formatMessage(messages.step5, rich)}</li>
              </ol>
            </section>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <section>
              <h3 className="mb-2 font-bold text-green-400">
                {intl.formatMessage(messages.doTitle)}
              </h3>
              <ul className="space-y-1">
                {[
                  messages.do1,
                  messages.do2,
                  messages.do3,
                  messages.do4,
                  messages.do5,
                ].map((m) => (
                  <li key={m.id} className="flex gap-2">
                    <CheckCircleIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-500" />
                    <span>{intl.formatMessage(m)}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h3 className="mb-2 font-bold text-red-400">
                {intl.formatMessage(messages.dontTitle)}
              </h3>
              <ul className="space-y-1">
                {[messages.dont1, messages.dont2, messages.dont3].map((m) => (
                  <li key={m.id} className="flex gap-2">
                    <XCircleIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-500" />
                    <span>{intl.formatMessage(m)}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <p className="text-gray-400">{intl.formatMessage(messages.after)}</p>
        </div>
      )}
    </div>
  );
};

export default RipGuide;
