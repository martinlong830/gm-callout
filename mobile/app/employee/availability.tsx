import { AvailabilityScreen } from '../../components/AvailabilityScreen';
import { useAppData } from '../../contexts/AppDataContext';

export default function EmployeeAvailability() {
  const { myEmployee } = useAppData();
  return <AvailabilityScreen mode="employee" selfEmployee={myEmployee} />;
}
