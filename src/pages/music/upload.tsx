import MusicUpload from '@app/components/MusicUpload';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const MusicUploadPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return <MusicUpload />;
};

export default MusicUploadPage;
