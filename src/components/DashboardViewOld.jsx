import React from 'react';
import { Clock, AlertCircle, CheckCircle, X, Edit, Eye, ThumbsUp, ThumbsDown, Trash2 } from 'lucide-react';
import './Dashboard.css';

const DashboardView = ({ rfps = [], onNewRfp, onEditRfp, onViewStrategies, onStatusChange, onDeleteRfp, onLoadSampleData }) => {
  const getStatusIcon = (status) => {
    switch (status) {
      case 'pending':
        return <Clock size={16} />;
      case 'reviewing':
        return <AlertCircle size={16} />;
      case 'approved':
        return <CheckCircle size={16} />;
      case 'declined':
        return <X size={16} />;
      default:
        return <Clock size={16} />;
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'pending':
        return 'status-pending';
      case 'reviewing':
        return 'status-reviewing';
      case 'approved':
        return 'status-approved';
      case 'declined':
        return 'status-declined';
      default:
        return 'status-pending';
    }
  };

  // Plain-language explanation shown as a tooltip on the status badge itself,
  // so the status meaning is discoverable without clicking anything.
  const getStatusExplanation = (status) => {
    switch (status) {
      case 'pending':
        return 'Awaiting review — no decision has been made yet';
      case 'reviewing':
        return 'Currently being evaluated by the sales team';
      case 'approved':
        return 'Won — this business has been booked';
      case 'declined':
        return 'Lost or turned down — no longer active';
      default:
        return 'Awaiting review — no decision has been made yet';
    }
  };

  return (
    <div className="dashboard-container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.5rem', fontWeight: 700 }}>Recent RFPs</h2>
        {rfps.length === 0 && (
          <button
            onClick={onLoadSampleData}
            className="btn-secondary"
            title="Populate the dashboard with example RFPs so you can explore the app before entering real data"
          >
            Load Sample Data
          </button>
        )}
      </div>

      {rfps.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '4rem', background: '#f7fafc', borderRadius: '0.75rem' }}>
          <p style={{ fontSize: '1.125rem', color: '#718096', marginBottom: '1rem' }}>
            No RFPs yet. Create your first one!
          </p>
          <button
            onClick={onNewRfp}
            className="btn-primary"
            title="Open a form to enter a new RFP — dates, rooms, rates, and meeting space — and add it to your pipeline"
          >
            + New RFP
          </button>
        </div>
      ) : (
        <div className="table-container">
          <table className="rfp-table">
            <thead>
              <tr>
                <th>Event Name</th>
                <th>Dates</th>
                <th>Attendees</th>
                <th>Rooms</th>
                <th>Est. Value</th>
                <th>Mtg Space</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rfps.map((rfp) => (
                <tr key={rfp.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{rfp.event_name}</div>
                    <div style={{ fontSize: '0.875rem', color: '#718096' }}>{rfp.organization}</div>
                  </td>
                  <td>
                    <div style={{ fontSize: '0.875rem' }}>
                      {new Date(rfp.arrival_date).toLocaleDateString()} - {new Date(rfp.departure_date).toLocaleDateString()}
                    </div>
                  </td>
                  <td>{rfp.attendees}</td>
                  <td>{rfp.room_block}</td>
                  <td>
                    {rfp.room_block && rfp.arrival_date && rfp.departure_date ? (() => {
                      const nights = Math.max(1, Math.ceil((new Date(rfp.departure_date) - new Date(rfp.arrival_date)) / 86400000));
                      const est = Math.round(rfp.room_block * nights * 144 * 0.7);
                      return (
                        <span
                          style={{ fontWeight: 600, color: '#2d3748' }}
                          title={`Estimated at $144/room average rate × ${rfp.room_block} rooms × ${nights} night${nights === 1 ? '' : 's'} × 70% expected pickup`}
                        >
                          ${est >= 1000 ? (est/1000).toFixed(0)+'K' : est}
                        </span>
                      );
                    })() : '—'}
                  </td>
                  <td>
                    {(() => {
                      const hasMtg = rfp.has_meeting_space;
                      const rooms = Number(rfp.room_block || 0);
                      const mtgAttendees = Number(rfp.meeting_attendees || rfp.attendees || 0);
                      const poorRatio = hasMtg && rooms > 0 && mtgAttendees / rooms > 3;
                      return hasMtg ? (
                        <span title={poorRatio ? 'High attendee-to-room ratio — confirm meeting space capacity before quoting' : 'This RFP requires meeting space in addition to guest rooms'}
                          style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem', color: poorRatio ? '#e53e3e' : '#38a169', fontWeight: 600 }}>
                          {poorRatio ? '⚠ Yes' : '✓ Yes'}
                        </span>
                      ) : <span style={{ color: '#a0aec0', fontSize: '0.8rem' }} title="Room-only business — no meeting space requested">—</span>;
                    })()}
                  </td>
                  <td>
                    <span
                      className={`status-badge ${getStatusColor(rfp.status)}`}
                      title={getStatusExplanation(rfp.status)}
                    >
                      {getStatusIcon(rfp.status)}
                      {rfp.status}
                    </span>
                  </td>
                  <td>
                    <div className="action-buttons">
                      <button 
                        onClick={() => onEditRfp(rfp)} 
                        className="btn-action btn-edit"
                        title="Edit — change this RFP's dates, room block, rates, or meeting space details"
                      >
                        <Edit size={16} />
                      </button>
                      <button 
                        onClick={() => onViewStrategies(rfp)} 
                        className="btn-action btn-view"
                        title="View Strategies — see pricing options and negotiation recommendations for this RFP"
                      >
                        <Eye size={16} />
                      </button>
                      {/* Always show approve/decline buttons */}
                      <button 
                        onClick={() => onStatusChange(rfp.id, 'approved')} 
                        className={`btn-action btn-approve ${rfp.status === 'approved' ? 'active' : ''}`}
                        title="Mark as Won — moves this RFP to booked business and updates occupancy"
                        aria-label="Approve RFP"
                      >
                        <ThumbsUp size={16} />
                      </button>
                      <button 
                        onClick={() => onStatusChange(rfp.id, 'declined')} 
                        className={`btn-action btn-decline ${rfp.status === 'declined' ? 'active' : ''}`}
                        title="Mark as Lost — declines this RFP and removes it from the active pipeline"
                        aria-label="Decline RFP"
                      >
                        <ThumbsDown size={16} />
                      </button>
                      <button
                        onClick={() => {
                          if (window.confirm(`Delete "${rfp.event_name}"? This cannot be undone.`)) {
                            onDeleteRfp(rfp.id);
                          }
                        }}
                        className="btn-action btn-delete"
                        title="Delete — permanently removes this RFP. This cannot be undone."
                        aria-label="Delete RFP"
                        style={{ color: '#e53e3e' }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default DashboardView;
